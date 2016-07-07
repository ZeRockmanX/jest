/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

'use strict';

import type {Config, Path} from 'types/Config';
import type {Environment} from 'types/Environment';
import type {HasteResolverContext} from 'types/Runtime';
import type Resolver from '../../jest-resolve/src';
import type {Script} from 'vm';

const createHasteMap = require('jest-haste-map').create;
const createResolver = require('jest-resolve').create;
const fs = require('graceful-fs');
const moduleMocker = require('jest-mock');
const path = require('path');
const transform = require('./transform');
const utils = require('jest-util');

type Module = {
  exports: any,
  filename: string,
  children?: Array<any>,
  parent?: Module,
  paths?: Array<Path>,
  require?: Function,
};

export type BuildHasteMapOptions = {
  maxWorkers: number,
};

const NODE_MODULES = path.sep + 'node_modules' + path.sep;

const mockParentModule = {
  exports: {},
  filename: 'mock.js',
  id: 'mockParent',
};

const normalizedIDCache = Object.create(null);
const unmockRegExpCache = new WeakMap();

type BooleanObject = {[key: string]: boolean};

class Runtime {
  _config: Config;
  _CoverageCollector: any;
  _coverageCollectors: Object;
  _coverageRegex: RegExp;
  _currentlyExecutingModulePath: string;
  _environment: Environment;
  _explicitShouldMock: BooleanObject;
  _isCurrentlyExecutingManualMock: ?string;
  _mockFactories: {[key: string]: () => any};
  _mockMetaDataCache: {[key: string]: Object};
  _mockRegistry: {[key: string]: any};
  _mocksPattern: ?RegExp;
  _moduleRegistry: {[key: string]: Module};
  _resolver: Resolver;
  _shouldAutoMock: boolean;
  _shouldMockModuleCache: BooleanObject;
  _shouldUnmockTransitiveDependenciesCache: BooleanObject;
  _testRegex: RegExp;
  _transitiveShouldMock: BooleanObject;
  _unmockList: ?RegExp;
  _virtualMocks: BooleanObject;

  constructor(
    config: Config,
    environment: Environment,
    resolver: Resolver,
  ) {
    this._moduleRegistry = Object.create(null);
    this._mockRegistry = Object.create(null);
    this._config = config;
    this._environment = environment;
    this._resolver = resolver;

    this._coverageCollectors = Object.create(null);
    this._currentlyExecutingModulePath = '';
    this._explicitShouldMock = Object.create(null);
    this._isCurrentlyExecutingManualMock = null;
    this._mockFactories = Object.create(null);
    this._mocksPattern =
      config.mocksPattern ? new RegExp(config.mocksPattern) : null;
    this._shouldAutoMock = config.automock;
    this._testRegex = new RegExp(config.testRegex.replace(/\//g, path.sep));
    this._coverageRegex = new RegExp(
      config.coveragePathIgnorePatterns.join('|').replace(/\//g, path.sep),
    );
    this._virtualMocks = Object.create(null);

    this._mockMetaDataCache = Object.create(null);
    this._shouldMockModuleCache = Object.create(null);
    this._shouldUnmockTransitiveDependenciesCache = Object.create(null);
    this._transitiveShouldMock = Object.create(null);

    if (config.collectCoverage) {
      // $FlowFixMe flow doesn't allow dynamic requires
      this._CoverageCollector = require(config.coverageCollector);
    }

    this._unmockList = unmockRegExpCache.get(config);
    if (!this._unmockList && config.unmockedModulePathPatterns) {
      this._unmockList =
        new RegExp(config.unmockedModulePathPatterns.join('|'));
      unmockRegExpCache.set(config, this._unmockList);
    }

    const unmockPath = filePath => {
      if (filePath && filePath.includes(NODE_MODULES)) {
        const moduleID = this._normalizeID(filePath);
        this._transitiveShouldMock[moduleID] = false;
      }
    };

    config.setupFiles.forEach(unmockPath);

    this.resetModuleRegistry();

    if (config.setupFiles.length) {
      for (let i = 0; i < config.setupFiles.length; i++) {
        this.requireModule(config.setupFiles[i]);
      }
    }
  }

  static buildHasteMap(
    config: Config,
    options: {maxWorkers: number},
  ): Promise<HasteResolverContext> {
    utils.createDirectory(config.cacheDirectory);
    const instance = createHasteMap(config, {
      maxWorkers: options.maxWorkers,
      resetCache: !config.cache,
    });
    return instance.build().then(
      moduleMap => ({
        instance,
        moduleMap,
        resolver: createResolver(config, moduleMap),
      }),
      error => {
        throw error;
      },
    );
  }

  static runCLI(args?: Object, info?: Array<string>) {
    return require('./cli').run(args, info);
  }

  static getCLIOptions() {
    return require('./cli/args').options;
  }

  requireModule(from: Path, moduleName?: string) {
    const moduleID = this._normalizeID(from, moduleName);
    let modulePath;

    // Some old tests rely on this mocking behavior. Ideally we'll change this
    // to be more explicit.
    let manualMockResource = null;
    let moduleResource = null;
    moduleResource = moduleName && this._resolver.getModule(moduleName);
    manualMockResource = moduleName && this._resolver.getMockModule(moduleName);
    if (
      !moduleResource &&
      manualMockResource &&
      manualMockResource !== this._isCurrentlyExecutingManualMock &&
      this._explicitShouldMock[moduleID] !== false
    ) {
      modulePath = manualMockResource;
    }

    if (moduleName && this._resolver.isCoreModule(moduleName)) {
      // $FlowFixMe
      return require(moduleName);
    }

    if (!modulePath) {
      modulePath = this._resolveModule(from, moduleName);
    }

    if (!this._moduleRegistry[modulePath]) {
      // We must register the pre-allocated module object first so that any
      // circular dependencies that may arise while evaluating the module can
      // be satisfied.
      const localModule = {
        filename: modulePath,
        exports: {},
      };

      this._moduleRegistry[modulePath] = localModule;
      if (path.extname(modulePath) === '.json') {
        localModule.exports = this._environment.global.JSON.parse(
          fs.readFileSync(modulePath, 'utf8'),
        );
      } else if (path.extname(modulePath) === '.node') {
        // $FlowFixMe
        localModule.exports = require(modulePath);
      } else {
        this._execModule(localModule);
      }
    }
    return this._moduleRegistry[modulePath].exports;
  }

  requireMock(from: Path, moduleName: string) {
    const moduleID = this._normalizeID(from, moduleName);

    if (this._mockRegistry[moduleID]) {
      return this._mockRegistry[moduleID];
    }

    if (moduleID in this._mockFactories) {
      return this._mockRegistry[moduleID] = this._mockFactories[moduleID]();
    }

    let manualMockResource = this._resolver.getMockModule(moduleName);
    let modulePath;
    if (manualMockResource) {
      modulePath = this._resolveModule(from, manualMockResource);
    } else {
      modulePath = this._resolveModule(from, moduleName);

      // If the actual module file has a __mocks__ dir sitting immediately next
      // to it, look to see if there is a manual mock for this file.
      //
      // subDir1/MyModule.js
      // subDir1/__mocks__/MyModule.js
      // subDir2/MyModule.js
      // subDir2/__mocks__/MyModule.js
      //
      // Where some other module does a relative require into each of the
      // respective subDir{1,2} directories and expects a manual mock
      // corresponding to that particular MyModule.js file.
      const moduleDir = path.dirname(modulePath);
      const moduleFileName = path.basename(modulePath);
      const potentialManualMock =
        path.join(moduleDir, '__mocks__', moduleFileName);
      if (fs.existsSync(potentialManualMock)) {
        manualMockResource = true;
        modulePath = potentialManualMock;
      }
    }

    if (manualMockResource) {
      const localModule = {
        exports: {},
        filename: modulePath,
      };
      this._execModule(localModule);
      this._mockRegistry[moduleID] = localModule.exports;
    } else {
      // Look for a real module to generate an automock from
      this._mockRegistry[moduleID] = this._generateMock(from, moduleName);
    }

    return this._mockRegistry[moduleID];
  }

  requireModuleOrMock(from: Path, moduleName: string) {
    if (this._shouldMock(from, moduleName)) {
      return this.requireMock(from, moduleName);
    } else {
      return this.requireModule(from, moduleName);
    }
  }

  resetModuleRegistry() {
    this._mockRegistry = Object.create(null);
    this._moduleRegistry = Object.create(null);

    if (this._environment && this._environment.global) {
      const envGlobal = this._environment.global;
      Object.keys(envGlobal).forEach(key => {
        const globalMock = envGlobal[key];
        if (
          (typeof globalMock === 'object' && globalMock !== null) ||
          typeof globalMock === 'function'
        ) {
          globalMock._isMockFunction && globalMock.mockClear();
        }
      });

      if (envGlobal.mockClearTimers) {
        envGlobal.mockClearTimers();
      }
    }
  }

  getAllCoverageInfo() {
    const coverage = Object.create(null);
    if (this._config.collectCoverage) {
      const collectors = this._coverageCollectors;
      for (const filePath in collectors) {
        coverage[filePath] = collectors[filePath].extractRuntimeCoverageInfo();
      }
    }
    return coverage;
  }

  setMock(
    from: string,
    moduleName: string,
    mockFactory: () => any,
    options?: {virtual: boolean},
  ) {
    if (options && options.virtual) {
      const mockPath = this._getVirtualMockPath(from, moduleName);
      this._virtualMocks[mockPath] = true;
    }
    const moduleID = this._normalizeID(from, moduleName);
    this._explicitShouldMock[moduleID] = true;
    this._mockFactories[moduleID] = mockFactory;
  }

  _resolveModule(from: Path, to?: ?string) {
    return to ? this._resolver.resolveModule(from, to) : from;
  }

  _shouldCollectCoverage(filename: Path) {
    const collectOnlyFrom = this._config.collectCoverageOnlyFrom;
    const shouldCollectCoverage = (
      (this._config.collectCoverage && !collectOnlyFrom) ||
      (collectOnlyFrom && collectOnlyFrom[filename])
    );
    return (
      shouldCollectCoverage &&
      !this._coverageRegex.test(filename) &&
      !(this._mocksPattern && this._mocksPattern.test(filename)) &&
      !this._testRegex.test(filename)
    );
  }

  _execModule(localModule: Module) {
    // If the environment was disposed, prevent this module from being executed.
    if (!this._environment.global) {
      return;
    }

    const filename = localModule.filename;
    const shouldCollectCoverage = this._shouldCollectCoverage(filename);
    const collectors = this._coverageCollectors;
    if (shouldCollectCoverage && !collectors[filename]) {
      collectors[filename] = new this._CoverageCollector();
    }
    const collectorStore =
      shouldCollectCoverage && collectors[filename].getCoverageDataStore();

    const lastExecutingModulePath = this._currentlyExecutingModulePath;
    this._currentlyExecutingModulePath = filename;
    const origCurrExecutingManualMock = this._isCurrentlyExecutingManualMock;
    this._isCurrentlyExecutingManualMock = filename;

    const dirname = path.dirname(filename);
    localModule.children = [];
    localModule.parent = mockParentModule;
    localModule.paths = this._resolver.getModulePaths(dirname);
    localModule.require = this._createRequireImplementation(filename);

    const script = transform(filename, this._config, {
      instrument: shouldCollectCoverage && (
        source => collectors[filename].getInstrumentedSource(
          source,
          filename,
          '$JEST',
        )
      ),
    });
    const wrapper = this._runScript(script, filename);
    wrapper.call(
      localModule.exports, // module context
      localModule, // module object
      localModule.exports, // module exports
      localModule.require, // require implementation
      dirname, // __dirname
      filename, // __filename
      this._environment.global, // global object
      this._createRuntimeFor(filename), // jest object
      collectorStore, // the coverage object
    );

    this._isCurrentlyExecutingManualMock = origCurrExecutingManualMock;
    this._currentlyExecutingModulePath = lastExecutingModulePath;
  }

  _runScript(script: Script, filename: string) {
    try {
      return this._environment.runScript(script)[
        transform.EVAL_RESULT_VARIABLE
      ];
    } catch (e) {
      const config = this._config;
      const relative = filePath => path.relative(config.rootDir, filePath);
      if (e.constructor.name === 'SyntaxError') {
        const hasPreprocessor = config.scriptPreprocessor;
        const preprocessorInfo = hasPreprocessor
          ? relative(config.scriptPreprocessor)
          : `No preprocessor specified, consider installing 'babel-jest'`;
        const babelInfo = config.usesBabelJest
          ? `Make sure your '.babelrc' is set up correctly, ` +
            `for example it should include the 'es2015' preset.\n`
          : '';
        /* eslint-disable max-len */
        throw new SyntaxError(
          `${e.message} in file '${relative(filename)}'.\n\n` +
          `Make sure your preprocessor is set up correctly and ensure ` +
          `your 'preprocessorIgnorePatterns' configuration is correct: http://facebook.github.io/jest/docs/api.html#preprocessorignorepatterns-array-string\n` +
          'If you are currently setting up Jest or modifying your preprocessor, try `jest --no-cache`.\n' +
          `Preprocessor: ${preprocessorInfo}.\n${babelInfo}`,
        );
        /* eslint-enable max-len */
      }
      throw e;
    }
  }

  _generateMock(from: Path, moduleName: string) {
    const modulePath = this._resolveModule(from, moduleName);

    if (!(modulePath in this._mockMetaDataCache)) {
      // This allows us to handle circular dependencies while generating an
      // automock
      this._mockMetaDataCache[modulePath] = moduleMocker.getMetadata({});

      // In order to avoid it being possible for automocking to potentially
      // cause side-effects within the module environment, we need to execute
      // the module in isolation. This could cause issues if the module being
      // mocked has calls into side-effectful APIs on another module.
      const origMockRegistry = this._mockRegistry;
      const origModuleRegistry = this._moduleRegistry;
      this._mockRegistry = Object.create(null);
      this._moduleRegistry = Object.create(null);

      const moduleExports = this.requireModule(from, moduleName);

      // Restore the "real" module/mock registries
      this._mockRegistry = origMockRegistry;
      this._moduleRegistry = origModuleRegistry;

      const mockMetadata = moduleMocker.getMetadata(moduleExports);
      if (mockMetadata === null) {
        throw new Error(
          `Failed to get mock metadata: ${modulePath}\n\n` +
          `See: http://facebook.github.io/jest/docs/manual-mocks.html#content`,
        );
      }
      this._mockMetaDataCache[modulePath] = mockMetadata;
    }
    return moduleMocker.generateFromMetadata(
      this._mockMetaDataCache[modulePath],
    );
  }

  _normalizeID(from: Path, moduleName?: ?string) {
    if (!moduleName) {
      moduleName = '';
    }

    const key = from + path.delimiter + moduleName;
    if (normalizedIDCache[key]) {
      return normalizedIDCache[key];
    }

    let moduleType;
    let mockPath = null;
    let absolutePath = null;

    if (this._resolver.isCoreModule(moduleName)) {
      moduleType = 'node';
      absolutePath = moduleName;
    } else {
      moduleType = 'user';
      if (
        !this._resolver.getModule(moduleName) &&
        !this._resolver.getMockModule(moduleName)
      ) {
        if (moduleName) {
          const virtualMockPath = this._getVirtualMockPath(from, moduleName);
          if (virtualMockPath in this._virtualMocks) {
            absolutePath = virtualMockPath;
          }
        }

        if (absolutePath === null) {
          absolutePath = this._resolveModule(from, moduleName);
        }

        // Look up if this module has an associated manual mock.
        const mockModule = this._resolver.getMockModule(moduleName);
        if (mockModule) {
          mockPath = mockModule;
        }
      }

      if (absolutePath === null) {
        const moduleResource = this._resolver.getModule(moduleName);
        if (moduleResource) {
          absolutePath = moduleResource;
        }
      }

      if (mockPath === null) {
        const mockResource = this._resolver.getMockModule(moduleName);
        if (mockResource) {
          mockPath = mockResource;
        }
      }
    }

    const sep = path.delimiter;
    const id = moduleType + sep + (absolutePath || '') + sep + (mockPath || '');
    return normalizedIDCache[key] = id;
  }

  _getVirtualMockPath(from: Path, moduleName: string) {
    if (moduleName[0] !== '.' && moduleName[0] !== '/') {
      return moduleName;
    }
    return path.normalize(path.dirname(from) + '/' + moduleName);
  }

  _shouldMock(from: Path, moduleName: string) {
    const mockPath = this._getVirtualMockPath(from, moduleName);
    if (mockPath in this._virtualMocks) {
      return true;
    }

    const explicitShouldMock = this._explicitShouldMock;
    const moduleID = this._normalizeID(from, moduleName);
    const key = from + path.delimiter + moduleID;

    if (moduleID in explicitShouldMock) {
      return explicitShouldMock[moduleID];
    }

    if (
      !this._shouldAutoMock ||
      this._resolver.isCoreModule(moduleName) ||
      this._shouldUnmockTransitiveDependenciesCache[key]
    ) {
      return false;
    }

    if (moduleID in this._shouldMockModuleCache) {
      return this._shouldMockModuleCache[moduleID];
    }

    const manualMockResource = this._resolver.getMockModule(moduleName);
    let modulePath;
    try {
      modulePath = this._resolveModule(from, moduleName);
    } catch (e) {
      if (manualMockResource) {
        this._shouldMockModuleCache[moduleID] = true;
        return true;
      }
      throw e;
    }

    if (this._unmockList && this._unmockList.test(modulePath)) {
      this._shouldMockModuleCache[moduleID] = false;
      return false;
    }

    // transitive unmocking for package managers that store flat packages (npm3)
    const currentModuleID = this._normalizeID(from);
    if (
      this._transitiveShouldMock[currentModuleID] === false || (
        from.includes(NODE_MODULES) &&
        modulePath.includes(NODE_MODULES) &&
        (
          (this._unmockList && this._unmockList.test(from)) ||
          explicitShouldMock[currentModuleID] === false
        )
      )
    ) {
      this._transitiveShouldMock[moduleID] = false;
      this._shouldUnmockTransitiveDependenciesCache[key] = true;
      return false;
    }

    return this._shouldMockModuleCache[moduleID] = true;
  }

  _createRequireImplementation(from: Path) {
    const moduleRequire = this.requireModuleOrMock.bind(this, from);
    moduleRequire.requireMock = this.requireMock.bind(this, from);
    moduleRequire.requireActual = this.requireModule.bind(this, from);
    moduleRequire.resolve = moduleName => this._resolveModule(from, moduleName);
    moduleRequire.cache = Object.create(null);
    moduleRequire.extensions = Object.create(null);
    return moduleRequire;
  }

  _createRuntimeFor(from: Path) {
    const disableAutomock = () => {
      this._shouldAutoMock = false;
      return runtime;
    };
    const enableAutomock = () => {
      this._shouldAutoMock = true;
      return runtime;
    };
    const unmock = (moduleName: string) => {
      const moduleID = this._normalizeID(from, moduleName);
      this._explicitShouldMock[moduleID] = false;
      return runtime;
    };
    const deepUnmock = (moduleName: string) => {
      const moduleID = this._normalizeID(from, moduleName);
      this._explicitShouldMock[moduleID] = false;
      this._transitiveShouldMock[moduleID] = false;
      return runtime;
    };
    const mock = (
      moduleName: string,
      mockFactory: Object,
      options: {virtual: boolean}
    ) => {
      if (mockFactory !== undefined) {
        return setMockFactory(moduleName, mockFactory, options);
      }

      const moduleID = this._normalizeID(from, moduleName);
      this._explicitShouldMock[moduleID] = true;
      return runtime;
    };
    const setMockFactory = (moduleName, mockFactory, options) => {
      this.setMock(from, moduleName, mockFactory, options);
      return runtime;
    };
    const useFakeTimers = () => {
      this._environment.fakeTimers.useFakeTimers();
      return runtime;
    };
    const useRealTimers = () => {
      this._environment.fakeTimers.useRealTimers();
      return runtime;
    };

    const runtime = {
      addMatchers: (matchers: Object) => {
        const jasmine = this._environment.global.jasmine;
        const addMatchers =
          jasmine.addMatchers || jasmine.getEnv().currentSpec.addMatchers;
        addMatchers(matchers);
      },

      autoMockOff: disableAutomock,
      disableAutomock,

      autoMockOn: enableAutomock,
      enableAutomock,

      clearAllTimers: () => this._environment.fakeTimers.clearAllTimers(),

      dontMock: unmock,
      unmock,

      getTestEnvData: () => {
        const frozenCopy = {};
        // Make a shallow copy only because a deep copy seems like
        // overkill..
        Object.keys(this._config.testEnvData).forEach(
          key => frozenCopy[key] = this._config.testEnvData[key],
        );
        Object.freeze(frozenCopy);
        return frozenCopy;
      },

      genMockFromModule: (moduleName: string) => {
        return this._generateMock(from, moduleName);
      },
      genMockFunction: moduleMocker.getMockFunction,
      genMockFn: moduleMocker.getMockFunction,
      fn() {
        const fn = moduleMocker.getMockFunction();
        if (arguments.length > 0) {
          return fn.mockImplementation(arguments[0]);
        }
        return fn;
      },
      isMockFunction: moduleMocker.isMockFunction,

      doMock: mock,
      mock,

      resetModuleRegistry: () => {
        this.resetModuleRegistry();
        return runtime;
      },

      runAllTicks: () => this._environment.fakeTimers.runAllTicks(),
      runAllImmediates: () => this._environment.fakeTimers.runAllImmediates(),
      runAllTimers: () => this._environment.fakeTimers.runAllTimers(),
      runOnlyPendingTimers: () =>
        this._environment.fakeTimers.runOnlyPendingTimers(),

      setMock: (moduleName: string, mock: Object) =>
        setMockFactory(moduleName, () => mock),

      deepUnmock,

      useFakeTimers,
      useRealTimers,
    };
    return runtime;
  }
}

module.exports = Runtime;
