---
sidebarDepth: 3
---

# 模块解析


## 生产环境中

在生产构建流程中，`Vite` 会借助 `rollup` 的能力来进行构建产物，以下是 `rollup` 构建流程

```js
async build() {
  timeStart('generate module graph', 2);
  await this.generateModuleGraph();
  timeEnd('generate module graph', 2);
  timeStart('sort modules', 2);
  this.phase = BuildPhase.ANALYSE;
  this.sortModules();
  timeEnd('sort modules', 2);
  timeStart('mark included statements', 2);
  this.includeStatements();
  timeEnd('mark included statements', 2);
  this.phase = BuildPhase.GENERATE;
}

async function rollupInternal (rawInputOptions, watcher) {
  await graph.pluginDriver.hookParallel('buildStart', [inputOptions]);
  await graph.build();
}
```

简单来说可以分为 **`生成模块间依赖关系`**、**`按照模块执行加载进行排序`**、**`tree shaking 处理`**。而本节中的 **`模块解析`** 流程就是第一步(**`生成模块间依赖关系`**)。

通过检索代码执行路径 ( `generateModuleGraph` -> `addEntryModules` -> `loadEntryModule` -> `fetchModule`) 可以发现最后会执行 `fetchModule` 来执行模块解析流程。

模块解析的流程可以简单的概括为 **`构建来源`**、 **`源码的获取`** 、 **`调用插件的 transform hook 转译源码`** 、**`构建模块上下文和初始化 ast 实例`**。

### 构建来源

构建来源从源码上看由两部分组成。第一部分是以 **`this.options.input`** 作为入口进行解析，代码如下:

```js
async generateModuleGraph() {
  ({ entryModules: this.entryModules, implicitEntryModules: this.implicitEntryModules } =
    await this.moduleLoader.addEntryModules(normalizeEntryModules(this.options.input), true));
  if (this.entryModules.length === 0) {
    throw new Error('You must supply options.input to rollup');
  }
  /**
   * modulesById 中包含了 this.emitFile 和 this.options.input 所关联的模块
   */
  for (const module of this.modulesById.values()) {
    if (module instanceof Module) {
      this.modules.push(module);
    }
    else {
      this.externalModules.push(module);
    }
  }
}
```

另一部分是通过 `emitChunk` 的方式来注入入口模块，简化代码如下:

```js
class ModuleLoader {
  async emitChunk({ fileName, id, importer, name, implicitlyLoadedAfterOneOf, preserveSignature }) {
    const unresolvedModule = {
      fileName: fileName || null,
      id,
      importer,
      name: name || null
    };
    const module = implicitlyLoadedAfterOneOf
      ? await this.addEntryWithImplicitDependants(unresolvedModule, implicitlyLoadedAfterOneOf)
      : (await this.addEntryModules([unresolvedModule], false)).newEntryModules[0];
    if (preserveSignature != null) {
      module.preserveSignature = preserveSignature;
    }
    return module;
  }
}

class FileEmitter {
  this.emitFile = (emittedFile) => {
    if (!hasValidType(emittedFile)) {
      return error(errFailedValidation(`Emitted files must be of type "asset" or "chunk", received "${emittedFile && emittedFile.type}".`));
    }
    if (!hasValidName(emittedFile)) {
      return error(errFailedValidation(`The "fileName" or "name" properties of emitted files must be strings that are neither absolute nor relative paths, received "${emittedFile.fileName || emittedFile.name}".`));
    }
    if (emittedFile.type === 'chunk') {
      return this.emitChunk(emittedFile);
    }
    return this.emitAsset(emittedFile);
  };
  emitChunk(emittedChunk) {
    if (this.graph.phase > BuildPhase.LOAD_AND_PARSE) {
      return error(errInvalidRollupPhaseForChunkEmission());
    }
    if (typeof emittedChunk.id !== 'string') {
      return error(errFailedValidation(`Emitted chunks need to have a valid string id, received "${emittedChunk.id}"`));
    }
    const consumedChunk = {
      fileName: emittedChunk.fileName,
      module: null,
      name: emittedChunk.name || emittedChunk.id,
      type: 'chunk'
    };
    this.graph.moduleLoader
      .emitChunk(emittedChunk)
      .then(module => (consumedChunk.module = module))
      .catch(() => {
      // Avoid unhandled Promise rejection as the error will be thrown later
      // once module loading has finished
    });
    return this.assignReferenceId(consumedChunk, emittedChunk.id);
  }
}

class PluginDriver {
  constructor () {
    this.emitFile = this.fileEmitter.emitFile.bind(this.fileEmitter);
    this.pluginContexts = new Map(this.plugins.map(plugin => [
      plugin,
      getPluginContext(plugin, pluginCache, graph, options, this.fileEmitter, existingPluginNames)
    ]));
  }
}

async function transform(source, module, pluginDriver, warn) {
  code = await pluginDriver.hookReduceArg0('transform', [curSource, id], transformReducer, (pluginContext, plugin) => {
    pluginName = plugin.name;
    pluginContext = this.pluginContexts.get(plugin);
    pluginContext = {
      emitAsset: getDeprecatedContextHandler((name, source) => fileEmitter.emitFile({ name, source, type: 'asset' }), 'emitAsset', 'emitFile', plugin.name, true, options),
      emitChunk: getDeprecatedContextHandler((id, options) => fileEmitter.emitFile({ id, name: options && options.name, type: 'chunk' }), 'emitChunk', 'emitFile', plugin.name, true, options),
      emitFile: fileEmitter.emitFile.bind(fileEmitter),
    }
    return {
      ...pluginContext,
      emitAsset(name, source) {
        emittedFiles.push({ name, source, type: 'asset' });
        return pluginContext.emitAsset(name, source);
      },
      emitChunk(id, options) {
        emittedFiles.push({ id, name: options && options.name, type: 'chunk' });
        return pluginContext.emitChunk(id, options);
      },
      emitFile(emittedFile) {
        emittedFiles.push(emittedFile);
        return pluginDriver.emitFile(emittedFile);
      },
    };
});
}
```

简单提一下上述代码流程，在执行插件的 `hook` 的时候会注入 `context`，在上下文中提供了 `fileEmitter.emitFile` 的能力，而在 `emitFile` 中依旧是使用了 `this.graph.moduleLoader.emitChunk`，**即最终还是调用了 `ModuleLoader` 模块中的 `emitChunk` 能力**。

**举以下例子来探索生产上是如何借助 `emitChunk` 能力来作为入口构建模块：**

在 **`vite-plugin-federation`** 模块联邦插件中，可以发现若对外暴露模块那么在 **`buildStart`** 阶段(早于 **`generateModuleGraph`** )会执行 `emitFile` 来将 `__remoteEntryHelper__` 虚拟模块作为入口执行构建流程。

```js
function prodExposePlugin(options) {
  return {
    name: 'originjs:expose-production',
    buildStart() {
      // if we don't expose any modules, there is no need to emit file
      if (parsedOptions.prodExpose.length > 0) {
        this.emitFile({
          fileName: `${builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''}${options.filename}`,
          type: 'chunk',
          id: '__remoteEntryHelper__',
          preserveSignature: 'strict'
        });
      }
    },
  }
}

```

因此对于上述 **`__remoteEntryHelper__`** 模块构建时机是早于第一种情况(以 **`this.options.input`** 作为入口)。

到此我们都知道对于 **`this.options.input`** 和 **`this.emitFile`** 的方式来作为入口模块会独立生成一个 **`chunk`**。 观察产物可以发现对于 **`import`** 方式来进行动态导入也是可以生成独立的 **`chunk`**，那么是如何做到的呢?

首先，我们需要了解的是 `rollup` 对于当前模块的子依赖模块会具体区分 **`静态模块`** 和 **`动态模块`**。在模块解析流程中大致一样，不过在生成 `chunk` 上会将具体的 `动态模块` 区分出来，并做单独的打包处理。

**代码简略流程如下:**

```js
function getChunkAssignments(entryModules, manualChunkAliasByEntry) {
  // ...
  const { dependentEntryPointsByModule, dynamicEntryModules } = analyzeModuleGraph(entryModules);
  chunkDefinitions.push(...createChunks([...entryModules, ...dynamicEntryModules], assignedEntryPointsByModule));
  // ...
  return chunkDefinitions;
}

async generateChunks() {
  for (const { alias, modules } of getChunkAssignments(this.graph.entryModules, manualChunkAliasByEntry)) {
    sortByExecutionOrder(modules);
    const chunk = new Chunk(modules, this.inputOptions, this.outputOptions, this.unsetOptions, this.pluginDriver, this.graph.modulesById, chunkByModule, this.facadeChunkByModule, this.includedNamespaces, alias);
    chunks.push(chunk);
    for (const module of modules) {
      chunkByModule.set(module, chunk);
    }
  }
  for (const chunk of chunks) {
    chunk.link();
  }
  const facades = [];
  for (const chunk of chunks) {
    facades.push(...chunk.generateFacades());
  }
  return [...chunks, ...facades];
}
```

以上可以发现 `chunk` 是由 `entryModules`（通过 `this.options.input` 与 `this.emitFile` 构建的模块） 和 `dynamicEntryModules`（`import()` 所关联的模块） 两大模块组成的。

### 源码的获取

**简化代码:**

```js
async addModuleSource(id, importer, module) {
  timeStart('load modules', 3);
  let source;
  try {
    /**
     * readQueue: 
     * 限制并行的异步任务数量(options.maxParallelFileReads)
     */
    source = await this.readQueue.run(async () => { 
      var _a; 
      return (_a = (await this.pluginDriver.hookFirst('load', [id]))) !== null && _a !== void 0 
      ? _a 
      : (await promises.readFile(id, 'utf8')); 
    });
  }
  catch (err) {
      // ...
  }
  // ...
}
```

可以很清晰地看出先执行所有插件的 **`load`** hook，如果有返回值即为加载的结果，若没有返回值则借助于 **`fs`** 的能力读取本地文件。

::: tip 为什么需要 `load` 加载?
的确，通常使用 `fs` 来读取本地文件就能满足需求，当然大部分情况下也是如此。使用 `load` plugin 很大程度上是为了 `虚拟模块` 所服务的。
在 `@originjs/vite-plugin-federation` 模块联邦插件中就使用了大量的虚拟模块，如 `virtualFile.__federation__`  、`virtualFile.__federation_lib_semver` 、 `virtualFile.__federation_fn_import` 、 `virtualFile. __remoteEntryHelper__` 等。
先执行 `load` 本质上对于 `vite` 来说，它并不了解需要解析的模块是 `虚拟模块` 还是 `真实模块`，因此需要先执行 `load`，若有返回值则为 `虚拟模块`
反之则为 `真实模块`。
:::

### 调用插件的 transform hook 转译源码

```js
await transform(sourceDescription, module, this.pluginDriver, this.options.onwarn)

async function transform(source, module, pluginDriver, warn) {
  const id = module.id;
  const sourcemapChain = [];
  let originalSourcemap = source.map === null ? null : decodedSourcemap(source.map);
  const originalCode = source.code;
  let ast = source.ast;
  const transformDependencies = [];
  const emittedFiles = [];
  let customTransformCache = false;
  const useCustomTransformCache = () => (customTransformCache = true);
  let pluginName = '';
  const curSource = source.code;
  // 格式化 code
  function transformReducer(previousCode, result, plugin) {
    let code;
    let map;
    if (typeof result === 'string') {
      code = result;
    }
    else if (result && typeof result === 'object') {
      module.updateOptions(result);
      if (result.code == null) {
        if (result.map || result.ast) {
          warn(errNoTransformMapOrAstWithoutCode(plugin.name));
        }
        return previousCode;
      }
      ({ code, map, ast } = result);
    }
    else {
      return previousCode;
    }
    // strict null check allows 'null' maps to not be pushed to the chain,
    // while 'undefined' gets the missing map warning
    if (map !== null) {
      sourcemapChain.push(decodedSourcemap(typeof map === 'string' ? JSON.parse(map) : map) || {
        missing: true,
        plugin: plugin.name
      });
    }
    return code;
  }
  let code;
  try {
    code = await pluginDriver.hookReduceArg0('transform', [curSource, id], transformReducer, (pluginContext, plugin) => {
      pluginName = plugin.name;
      return {
        ...pluginContext,
        emitAsset(name, source) {
          emittedFiles.push({ name, source, type: 'asset' });
          return pluginContext.emitAsset(name, source);
        },
        emitChunk(id, options) {
          emittedFiles.push({ id, name: options && options.name, type: 'chunk' });
          return pluginContext.emitChunk(id, options);
        },
        emitFile(emittedFile) {
          emittedFiles.push(emittedFile);
          return pluginDriver.emitFile(emittedFile);
        },
        // ...
      };
    });
  }
  catch (err) {
    throwPluginError(err, pluginName, { hook: 'transform', id });
  }
  if (!customTransformCache) {
      // files emitted by a transform hook need to be emitted again if the hook is skipped
    if (emittedFiles.length)
      module.transformFiles = emittedFiles;
  }
  return {
    code
    // ...
  };
}

/**
 * 插件驱动器，全局唯一实例。
 * 在构建依赖图实例中进行初始化
 * class Graph {
 *  constructor () {
 *    this.pluginDriver = new PluginDriver(this, options, options.plugins, this.pluginCache);
 *    this.acornParser = Parser.extend(...options.acornInjectPlugins);
 *    this.moduleLoader = new ModuleLoader(this, this.modulesById, this.options, this.pluginDriver);
 *  }
 * }
 * async function rollupInternal(rawInputOptions, watcher) {
 *  const graph = new Graph(inputOptions, watcher);
 * }
 */
class PluginDriver {
  hookReduceArg0(hookName, [arg0, ...rest], reduce, replaceContext) {
    let promise = Promise.resolve(arg0);
    for (const plugin of this.plugins) {
      promise = promise.then(arg0 => {
        const args = [arg0, ...rest];
        const hookPromise = this.runHook(hookName, args, plugin, false, replaceContext);
        // 如果当前插件没有做任何处理(返回 undefined 或 null)，那么就传递当前 source 继续链式处理。 
        if (!hookPromise)
          return arg0;
        /**
         * 每个插件都有其具体的执行上下文（pluginContexts）
         */
        return hookPromise.then(result => reduce.call(this.pluginContexts.get(plugin), arg0, result, plugin));
      });
    }
    return promise;
  }
  runHook(hookName, args, plugin, permitValues, hookContext) {
    const hook = plugin[hookName];
    if (!hook)
      return undefined;
    let context = this.pluginContexts.get(plugin);
    if (hookContext) {
      context = hookContext(context, plugin);
    }
    let action = null;
    return Promise.resolve()
        .then(() => {
        // permit values allows values to be returned instead of a functional hook
        if (typeof hook !== 'function') {
            if (permitValues)
                return hook;
            return throwInvalidHookError(hookName, plugin.name);
        }
        // eslint-disable-next-line @typescript-eslint/ban-types
        const hookResult = hook.apply(context, args);
        if (!hookResult || !hookResult.then) {
            // short circuit for non-thenables and non-Promises
            return hookResult;
        }
        // Track pending hook actions to properly error out when
        // unfulfilled promises cause rollup to abruptly and confusingly
        // exit with a successful 0 return code but without producing any
        // output, errors or warnings.
        action = [plugin.name, hookName, args];
        this.unfulfilledActions.add(action);
        // Although it would be more elegant to just return hookResult here
        // and put the .then() handler just above the .catch() handler below,
        // doing so would subtly change the defacto async event dispatch order
        // which at least one test and some plugins in the wild may depend on.
        return Promise.resolve(hookResult).then(result => {
            // action was fulfilled
            this.unfulfilledActions.delete(action);
            return result;
        });
    })
        .catch(err => {
        if (action !== null) {
            // action considered to be fulfilled since error being handled
            this.unfulfilledActions.delete(action);
        }
        return throwPluginError(err, plugin.name, { hook: hookName });
    });
  }
}
```

链式处理每一个插件中的 `hookName` 钩子。若插件没做处理，那么就传递上一个处理的源码给下一个插件执行，
若做了处理则会格式化插件的返回值并提取已经处理过的源码给下一个插件处理，直至所有的插件都执行完成后再将处理好的
源码进行返回。

::: warning TODO:
对于有关 `Vite` 注入核心插件的详细内容，之后会出专门的一章来进行讲解。
:::

### 构建模块上下文和初始化 ast 实例

**`transform`** 后的 `code` 即为纯 `js` 模块，因此可以借助 `acorn` 的能力来解析 `code` 为 `ast`。对于借助 `esbuild` 的能力来执行预构建流程，`userPlugin` 就不起作用了，可以通过配置 `config.optimizeDeps.esbuildOptions.plugin` 来扩展 `esbuild` 构建能力。

```js
setSource({ ast, code, customTransformCache, originalCode, originalSourcemap, resolvedIds, sourcemapChain, transformDependencies, transformFiles, ...moduleOptions }) {
  this.info.code = code;
  this.originalCode = originalCode;
  if (!ast) {
    /**
     * 借助 `acorn` 的能力来解析 `code` 为 `ast`。
     */
    ast = this.tryParse();
  }
  timeEnd('generate ast', 3);
  this.resolvedIds = resolvedIds || Object.create(null);
  // By default, `id` is the file name. Custom resolvers and loaders
  // can change that, but it makes sense to use it for the source file name
  const fileName = this.id;
  this.magicString = new MagicString(code, {
      filename: (this.excludeFromSourcemap ? null : fileName),
      indentExclusionRanges: []
  });
  timeStart('analyse ast', 3);
  /**
   * 初始化 ast 的上下文，在处理 ast 各个节点的时候会触发上下文中注入的能力。 
   */
  this.astContext = {
    addDynamicImport: this.addDynamicImport.bind(this),
    addExport: this.addExport.bind(this),
    addImport: this.addImport.bind(this),
    code,
    fileName,
    getExports: this.getExports.bind(this),
    getModuleName: this.basename.bind(this),
    getReexports: this.getReexports.bind(this),
    magicString: this.magicString,
    module: this,
    // ...
  };
  /**
   * this.graph.scope = new GlobalScope();
   * 构建当前模块的顶级作用域并继承于 global 的作用域。
   * 在 JS 中，作用域可以分为 全局作用域、 函数作用域、 eval 作用域，块级作用域(es6)。因此在遇到相关的 ast node 的时候会
   * 构建新的作用域并继承父级作用域。
   */
  this.scope = new ModuleScope(this.graph.scope, this.astContext);
  this.namespace = new NamespaceVariable(this.astContext);
  this.ast = new Program(ast, { context: this.astContext, type: 'Module' }, this.scope);
  this.info.ast = ast;
  timeEnd('analyse ast', 3);
}

```

以上最值得关注的应该是模块 **`ast`** 的构建流程。`rollup` 内部实现了大量 `node constructor`， 通过 `acorn` 生成的 `ast` 递归实例化 `node constructor`。

```js
class NodeBase extends ExpressionEntity {
  constructor(esTreeNode, parent, parentScope) {
    super();
    /**
     * Nodes can apply custom deoptimizations once they become part of the
     * executed code. To do this, they must initialize this as false, implement
     * applyDeoptimizations and call this from include and hasEffects if they have
     * custom handlers
     */
    this.deoptimized = false;
    this.esTreeNode = esTreeNode;
    this.keys = keys[esTreeNode.type] || getAndCreateKeys(esTreeNode);
    this.parent = parent;
    this.context = parent.context;
    // 构建可执行上下文
    this.createScope(parentScope);
    // 根据 ast 类型实例化 node constructor
    this.parseNode(esTreeNode);
    // 根据 ast node 信息来初始化 node constructor 实例
    this.initialise();
    this.context.magicString.addSourcemapLocation(this.start);
    this.context.magicString.addSourcemapLocation(this.end);
  }
}
```

由上述代码可以很清晰的了解到构建 `ast` 的时候**主要**会执行 `构建可执行上下文`、`根据 ast 类型实例化 node constructor`、`根据 ast node 信息来初始化 node constructor 实例`。

#### 构建可执行上下文

作用域的构建要么就是保持和父级作用域一致，要么就是构建新的作用域。通过 **`createScope`** 可以得知遇到如下节点情况下会构建新的作用域。

```js
class BlockStatement extends NodeBase {
  createScope(parentScope) {
    this.scope = this.parent.preventChildBlockScope
      ? parentScope
      : new BlockScope(parentScope);
  }
}
// for in 作用域
class ForInStatement extends NodeBase {
  createScope(parentScope) {
    this.scope = new BlockScope(parentScope);
  }
}

// for of 作用域
class ForOfStatement extends NodeBase {
  createScope(parentScope) {
    this.scope = new BlockScope(parentScope);
  }
}

// for 作用域
class ForStatement extends NodeBase {
  createScope(parentScope) {
    this.scope = new BlockScope(parentScope);
  }
}

// 静态块作用域
class StaticBlock extends NodeBase {
  createScope(parentScope) {
    this.scope = new BlockScope(parentScope);
  }
}

// switch 作用域
class SwitchStatement extends NodeBase {
  createScope(parentScope) {
    this.scope = new BlockScope(parentScope);
  }
}

// 箭头函数表达式 作用域
class ArrowFunctionExpression extends FunctionBase {
  createScope(parentScope) {
    this.scope = new ReturnValueScope(parentScope, this.context);
  }
}

// 函数作用域
class FunctionNode extends FunctionBase {
  createScope(parentScope) {
    this.scope = new FunctionScope(parentScope, this.context);
  }
}

class CatchClause extends NodeBase {
  createScope(parentScope) {
    this.scope = new CatchScope(parentScope, this.context);
  }
}

class ClassBody extends NodeBase {
  createScope(parentScope) {
    this.scope = new ClassBodyScope(parentScope, this.parent, this.context);
  }
}

class ClassNode extends NodeBase {
  createScope(parentScope) {
    this.scope = new ChildScope(parentScope);
  }
}
```

作用域构造函数最终均会继承于 `Scope$1` 基类。在不同场景下会构建对应的作用域，后续遇到声明的时候会构建 `variable` 对象，并将对象存储在对应的上下文中。




在 `generateModuleGraph` 函数中我们可以发现 。


```js
// If this is a preload, then this method always waits for the dependencies of the module to be resolved.
// Otherwise if the module does not exist, it waits for the module and all its dependencies to be loaded.
// Otherwise it returns immediately.
async fetchModule({ id, meta, moduleSideEffects, syntheticNamedExports }, importer, isEntry, isPreload) {
  /**
   * preload 场景:
   *  在预构建流程中，处理模块 transfrom 阶段的时候，vite:optimized-deps-build 插件会执行如下代码
   *  getDepsOptimizer(config)?.delayDepsOptimizerUntil(id, async () => {
   *     await this.load({ id });
   *  });
   *  代码主要流程为注册ID并在合适的时机中执行 load 处理， 而这里的 load 处理也就是 preload 处理。
   */
  const existingModule = this.modulesById.get(id);
  if (existingModule instanceof Module) {
      await this.handleExistingModule(existingModule, isEntry, isPreload);
      return existingModule;
  }
  // 实例化 Module
  const module = new Module(this.graph, id, this.options, isEntry, moduleSideEffects, syntheticNamedExports, meta);
  this.modulesById.set(id, module);
  this.graph.watchFiles[id] = true;
  const loadPromise = this.addModuleSource(id, importer, module).then(() => [
    // 获取子依赖模块路径
    this.getResolveStaticDependencyPromises(module),
    // 获取子依赖模块动态路径
    this.getResolveDynamicImportPromises(module),
    loadAndResolveDependenciesPromise
  ]);
  // 解析当前模块所有的子依赖模块
  const loadAndResolveDependenciesPromise = waitForDependencyResolution(loadPromise).then(() => this.pluginDriver.hookParallel('moduleParsed', [module.info]));
  loadAndResolveDependenciesPromise.catch(() => {
      /* avoid unhandled promise rejections */
  });
  this.moduleLoadPromises.set(module, loadPromise);
  // 等待模块解析完成但不包含子模块路径解析完成。
  const resolveDependencyPromises = await loadPromise;
  if (!isPreload) {
    // 解析当前模块所有的子模块依赖
    await this.fetchModuleDependencies(module, ...resolveDependencyPromises);
  }
  else if (isPreload === RESOLVE_DEPENDENCIES) {
    await loadAndResolveDependenciesPromise;
  }
  return module;
}

// 生成模块依赖图关键代码
async fetchStaticDependencies(module, resolveStaticDependencyPromises) {
  for (const dependency of await Promise.all(resolveStaticDependencyPromises.map(resolveStaticDependencyPromise => resolveStaticDependencyPromise.then(([source, resolvedId]) => this.fetchResolvedDependency(source, module.id, resolvedId))))) {
    // 当前模块绑定与子依赖模块之间的依赖关系
    module.dependencies.add(dependency);
    // 子依赖模块绑定和父模块之间的依赖关系
    dependency.importers.push(module.id);
  }
  // 如果模块不需要进行 treeshaking 处理则给当前模块所有的子依赖模块标记 importedFromNotTreeshaken = true。
  if (!this.options.treeshake || module.info.moduleSideEffects === 'no-treeshake') {
    for (const dependency of module.dependencies) {
      if (dependency instanceof Module) {
        dependency.importedFromNotTreeshaken = true;
      }
    }
  }
}
```

``


## 开发环境中



