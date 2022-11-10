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

简单来说可以分为 **`生成模块依赖图`**、**`按照模块执行排序排列`**、**`tree shaking 处理`**。而本节中的 **`模块解析`** 流程就是第一步(**`生成模块间依赖关系`**)。

模块解析的流程可以简单的概括为 **`确定构建来源`**、 **`源码的获取`** 、 **`转译源码`** 、**`构建模块上下文和初始化 ast 实例`**、 **`子依赖模块的收集和构建`**、 **`依赖关系的确定`**。

### 确定构建来源

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

### 转译源码

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

由上述代码可以很清晰的了解到构建 `ast` 的时候**主要**会执行 `构建可执行上下文`、`实例化 node constructor`、`初始化 node constructor 实例`。

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

#### 实例化 node constructor

递归 `ast` 并实例化对应的节点。在阅读这一块源码的同时，推荐借助于 [AST Explorer](https://astexplorer.net/) 来协助阅读，可以很清晰的看出`ast node` 具体对应于哪一段 `code`。

```js
class NodeBase extends ExpressionEntity {
  parseNode(esTreeNode) {
    for (const [key, value] of Object.entries(esTreeNode)) {
      // That way, we can override this function to add custom initialisation and then call super.parseNode
      // 处理过的 key 就不需要再处理一遍
      if (this.hasOwnProperty(key))
        continue;
      // 对于特殊 ast node 做特殊处理。
      if (key.charCodeAt(0) === 95 /* _ */) {
        if (key === ANNOTATION_KEY) {
          this.annotations = value;
        }
        else if (key === INVALID_COMMENT_KEY) {
          for (const { start, end } of value)
            this.context.magicString.remove(start, end);
        }
      }
      else if (typeof value !== 'object' || value === null) {
        // 如果值为 基本数据类型 或 null 时。
        this[key] = value;
      }
      else if (Array.isArray(value)) {
        // 如果值为数组的话则根据每一个 ast node 的类型来实例化节点。
        this[key] = [];
        for (const child of value) {
          this[key].push(child === null
            ? null
            : new (this.context.getNodeConstructor(child.type))(child, this, this.scope));
        }
      }
      else {
        // 如果值为对象的话则根据 ast node 的类型来实例化节点。
        this[key] = new (this.context.getNodeConstructor(value.type))(value, this, this.scope);
      }
    }
  }
}
```

从以上代码可以很清晰地看出来流程为根据当前 `ast node` 的结构来收集节点数据。遍历的时候若值存在对象( 数组说明存在多个 `子ast node`, 纯对象的话则只有一个 `子ast node` )的情况下就实例化 `子ast node` 对象。`子ast node` 对象实例化的时候继续按照以上流程实例化 `子ast node` 的 `子ast node`，以此通过递归的方式来实例化所有的 `ast node`。

::: tip ParseNode
  `parseNode` 的流程为递归所有的子 `ast node` 并为对应的 `ast node` 进行实例化，在实例对象中会收集 `ast` 节点中的所有数据。同时也是为了下面 `initialise` 初始化流程奠定了基础。
:::

#### 初始化 node constructor 实例
  
这个也是为初始化流程中最为重要的阶段，实例化对象中会对不同 `ast` 节点做不同的初始化处理。具体情况具体分析，举一个例子。

```js
const hello = 'world';
```

转化为 `JSON` 后的结构:

```json
{
  "type": "Program",
  "start": 0,
  "end": 22,
  "body": [
    {
      "type": "VariableDeclaration",
      "start": 0,
      "end": 22,
      "declarations": [
        {
          "type": "VariableDeclarator",
          "start": 6,
          "end": 21,
          "id": {
            "type": "Identifier",
            "start": 6,
            "end": 11,
            "name": "hello"
          },
          "init": {
            "type": "Literal",
            "start": 14,
            "end": 21,
            "value": "world",
            "raw": "'world'"
          }
        }
      ],
      "kind": "const"
    }
  ],
  "sourceType": "module"
}
```

由递归流程可知首次执行 `initialise` 的 `ast node` 结构如下:

```json
{
  "type": "Identifier",
  "start": 6,
  "end": 11,
  "name": "hello"
}
```

对于 `Identifier` 节点在初始化的时候不需要做任何操作。

第二次执行 `ast node` 为 `Literal` 节点，结构如下：

```json
{
  "type": "Literal",
  "start": 14,
  "end": 21,
  "value": "world",
  "raw": "'world'"
}
```

对于 `Literal` 节点在初始化的时候处理简略逻辑如下：

```js
function getLiteralMembersForValue(value) {
  switch (typeof value) {
    case 'boolean':
      return literalBooleanMembers;
    case 'number':
      return literalNumberMembers;
    case 'string':
      return literalStringMembers;
  }
  return Object.create(null);
}
class Literal extends NodeBase {
  initialise() {
    this.members = getLiteralMembersForValue(this.value);
  }
}
```

从代码逻辑上看会根据字面量类型返回字面量描述信息。

第三次执行 `ast node` 为 `VariableDeclarator` 节点，结构如下：

```json
{
  "type": "VariableDeclarator",
  "start": 6,
  "end": 21,
  "id": {
    "type": "Identifier",
    "start": 6,
    "end": 11,
    "name": "hello"
  },
  "init": {
    "type": "Literal",
    "start": 14,
    "end": 21,
    "value": "world",
    "raw": "'world'"
  }
}
```

对于 `VariableDeclarator` 节点在初始化的时候不需要做任何操作。

第四次执行 `ast node` 为 `VariableDeclaration` 节点，结构如下：

```json
{
  "type": "VariableDeclaration",
  "start": 0,
  "end": 22,
  "declarations": [
    {
      "type": "VariableDeclarator",
      "start": 6,
      "end": 21,
      "id": {
        "type": "Identifier",
        "start": 6,
        "end": 11,
        "name": "hello"
      },
      "init": {
        "type": "Literal",
        "start": 14,
        "end": 21,
        "value": "world",
        "raw": "'world'"
      }
    }
  ],
  "kind": "const"
}
```

对于 `VariableDeclaration` 节点在初始化的时候处理简略逻辑如下：

```js
class Scope$1 {
  addDeclaration(identifier, context, init, _isHoisted) {
    const name = identifier.name;
    let variable = this.variables.get(name);
    if (variable) {
      variable.addDeclaration(identifier, init);
    }
    else {
      variable = new LocalVariable(identifier.name, identifier, init || UNDEFINED_EXPRESSION, context);
      this.variables.set(name, variable);
    }
    return variable;
  }
}

class Identifier extends NodeBase {
  declare(kind, init) {
    let variable;
    const { treeshake } = this.context.options;
    switch (kind) {
      case 'var':
        variable = this.scope.addDeclaration(this, this.context, init, true);
        if (treeshake && treeshake.correctVarValueBeforeDeclaration) {
          // Necessary to make sure the init is deoptimized. We cannot call deoptimizePath here.
          variable.markInitializersForDeoptimization();
        }
        break;
      case 'function':
        // in strict mode, functions are only hoisted within a scope but not across block scopes
        variable = this.scope.addDeclaration(this, this.context, init, false);
        break;
      case 'let':
      case 'const':
      case 'class':
        variable = this.scope.addDeclaration(this, this.context, init, false);
        break;
      case 'parameter':
        variable = this.scope.addParameterDeclaration(this);
        break;
      /* istanbul ignore next */
      default:
        /* istanbul ignore next */
        throw new Error(`Internal Error: Unexpected identifier kind ${kind}.`);
    }
    variable.kind = kind;
    return [(this.variable = variable)];
  }
}

class VariableDeclarator extends NodeBase {
  declareDeclarator(kind) {
    this.id.declare(kind, this.init || UNDEFINED_EXPRESSION);
  }
}

class VariableDeclaration extends NodeBase {
  initialise() {
    for (const declarator of this.declarations) {
      declarator.declareDeclarator(this.kind);
    }
  }
}
```

从以上代码逻辑中可以看出来会将当前 `statement` 中的所有声明的变量进行实例化并注册到当前 `scope` 上下文中，当然申明的关键字不一样时处理逻辑也会有所区别。

### 子依赖模块的收集和构建

在递归实例化 `ast node` 之前我们会发现会往上下文中注入以下能力

```js
this.astContext = {
  addDynamicImport: this.addDynamicImport.bind(this),
  addExport: this.addExport.bind(this),
  addImport: this.addImport.bind(this),
  addImportMeta: this.addImportMeta.bind(this),
  code,
  deoptimizationTracker: this.graph.deoptimizationTracker,
  error: this.error.bind(this),
  fileName,
  getExports: this.getExports.bind(this),
  getModuleExecIndex: () => this.execIndex,
  getModuleName: this.basename.bind(this),
  getNodeConstructor: (name) => nodeConstructors[name] || nodeConstructors.UnknownNode,
  getReexports: this.getReexports.bind(this),
  importDescriptions: this.importDescriptions,
  includeAllExports: () => this.includeAllExports(true),
  includeDynamicImport: this.includeDynamicImport.bind(this),
  includeVariableInModule: this.includeVariableInModule.bind(this),
  magicString: this.magicString,
  module: this,
  moduleContext: this.context,
  options: this.options,
  requestTreeshakingPass: () => (this.graph.needsTreeshakingPass = true),
  traceExport: (name) => this.getVariableForExportName(name)[0],
  traceVariable: this.traceVariable.bind(this),
  usesTopLevelAwait: false,
  warn: this.warn.bind(this)
};

this.ast = new Program(ast, { context: this.astContext, type: 'Module' }, this.scope);
```

对于 **`addDynamicImport`**、 **`addExport`**、 **`addImport`** 需要重点关注一下，来看一下具体实现源码。

**对于 `addDynamicImport` 处理：**

在解析的时候处理流程如下：

```js
class Module {
  addDynamicImport(node) {
    let argument = node.source;
    // 模版字符串 import(`react`)
    if (argument instanceof TemplateLiteral) {
      if (argument.quasis.length === 1 && argument.quasis[0].value.cooked) {
        argument = argument.quasis[0].value.cooked;
      }
    }
    // 字符串 import('react')
    else if (argument instanceof Literal && typeof argument.value === 'string') {
      argument = argument.value;
    }
    this.dynamicImports.push({ argument, id: null, node, resolution: null });
  }
}
```

当处理类型为 `ImportExpression` 的 `ast` 节点时会进入此流程

```js
import('demo')

class ImportExpression extends NodeBase {
  initialise() {
    this.context.addDynamicImport(this);
  }
}
```

可以看出在处理 `ImportExpression` 节点初始化的时候会为当前 `module` 添加动态导入信息到 `dynamicImports` 变量中。

**对于 `addExport` 处理：**

处理 `addExport` 的流程会比上述复杂很多，`export` 导出方式可以分为以下几种:

+ 重导出方式，对应类型为 `ExportAllDeclaration` 的 `ast node`。

```js
/**
 * 导出 demo 模块中所有 具名导出 和 默认导出。
 * 可以看作：
 * == demo.js ==
 * export const a = 1, b = 2;
 * export default function Demo () {}
 * 
 * == index.js ==
 * import Demo, { a, b } from './demo.js';
 * export { a, b, Demo };
 * 
 * OR
 * 
 * == index.js ==
 * import { a, b, default as Demo } from './demo.js';
 * export { a, b, Demo };
 */
export * as demo from 'demo';

/**
 * 导出 demo 模块中所有 具名导出，因此导入的时候不能使用默认导入方式( import demo from './demo.js' )。
 * 可以看作：
 * == demo.js ==
 * export const a = 1, b = 2;
 * export default function Demo () {}
 * 
 * == index.js ==
 * import { a, b } from './demo.js';
 * export { a, b };
 */
export * from 'demo';
```

在解析的时候处理流程如下：

```js
class Module {
  addExport(node) {
    if (node instanceof ExportAllDeclaration) {
      const source = node.source.value;
      this.sources.add(source);
      if (node.exported) {
        // export * as name from './other'
        const name = node.exported.name;
        this.reexportDescriptions.set(name, {
          localName: '*',
          module: null,
          source,
          start: node.start
        });
      }
      else {
        // export * from './other'
        this.exportAllSources.add(source);
      }
    }
    // ...
  }
}
```

当处理类型为 `ExportAllDeclaration` 的 `ast` 节点时会进入此流程

```js
class ExportAllDeclaration extends NodeBase {
  initialise() {
    this.context.addExport(this);
  }
}
```

+ 默认导出，对应类型为 `ExportDefaultDeclaration` 的 `ast node`。

```js
export default 'demo';
```

在解析的时候处理流程如下：

```js
class Module {
  addExport(node) {
    if (node instanceof ExportDefaultDeclaration) {
      // export default foo;
      this.exports.set('default', {
        identifier: node.variable.getAssignedVariableName(),
        localName: 'default'
      });
    }
    // ...   
  } 
}
```

当处理类型为 `ExportAllDeclaration` 的 `ast` 节点时会进入此流程

```js
class ExportDefaultDeclaration extends NodeBase {
  initialise() {
    const declaration = this.declaration;
    this.declarationName =
      (declaration.id && declaration.id.name) || this.declaration.name;
    this.variable = this.scope.addExportDefaultDeclaration(this.declarationName || this.context.getModuleName(), this, this.context);
    this.context.addExport(this);
  }
}
```

+ 具名导出，对应类型为 `ExportNamedDeclaration` 的 `ast node`。

```js
export { demo } from 'demo';

export var demo = 1, foo = 2;

export function demo () {}

export { demo };
```

在解析的时候处理流程如下：

```js
class Module {
  addExport(node) {
    if (node.source instanceof Literal) {
        // export { name } from './other'
      const source = node.source.value;
      this.sources.add(source);
      for (const specifier of node.specifiers) {
        const name = specifier.exported.name;
        this.reexportDescriptions.set(name, {
          localName: specifier.local.name,
          module: null,
          source,
          start: specifier.start
        });
      }
    }
    else if (node.declaration) {
      const declaration = node.declaration;
      if (declaration instanceof VariableDeclaration) {
        // export var { foo, bar } = ...
        // export var foo = 1, bar = 2;
        for (const declarator of declaration.declarations) {
          for (const localName of extractAssignedNames(declarator.id)) {
            this.exports.set(localName, { identifier: null, localName });
          }
        }
      }
      else {
        // export function foo () {}
        const localName = declaration.id.name;
        this.exports.set(localName, { identifier: null, localName });
      }
    }
    else {
      // export { foo, bar, baz }
      for (const specifier of node.specifiers) {
        const localName = specifier.local.name;
        const exportedName = specifier.exported.name;
        this.exports.set(exportedName, { identifier: null, localName });
      }
    }
  }
  // ...
}
```

当处理类型为 `ExportNamedDeclaration` 的 `ast` 节点时会进入此流程

```js
class ExportNamedDeclaration extends NodeBase {
  initialise() {
    this.context.addExport(this);
  }
}
```

**对于 `addImport` 处理：**

在解析的时候处理流程如下：

```js
class Module {
  addImport(node) {
    const source = node.source.value;
    this.sources.add(source);
    for (const specifier of node.specifiers) {
      const isDefault = specifier.type === ImportDefaultSpecifier$1;
      const isNamespace = specifier.type === ImportNamespaceSpecifier$1;
      const name = isDefault ? 'default' : isNamespace ? '*' : specifier.imported.name;
      this.importDescriptions.set(specifier.local.name, {
        module: null,
        name,
        source,
        start: specifier.start
      });
    }
  }
}
```

当处理类型为 `ImportDeclaration` 的 `ast` 节点时会进入此流程

```js
import demo from 'demo';
import { a, default as demo } from 'demo';
import * as demo from 'demo';

class ImportDeclaration extends NodeBase {
  initialise() {
    this.context.addImport(this);
  }
}
```

::: tip 子依赖收集小结
`rollup` 在递归 `ast` 之前会注入上下文( `astContext` )，上下文为当前模块提供了收集依赖信息的能力。递归 `ast` 的时候会通过检测节点( `import`、 `export` )，提取节点信息并通过上下文( `astContext` )为 `module` 注入子依赖信息。
:::

子依赖收集流程已经介绍完成，接下来介绍的就是子依赖模块构建的流程。

从源码上可以看出在构建完当前模块后就会执行子模块路径的解析

**代码简略如下：**

```js
class ModuleLoader {
  getResolveStaticDependencyPromises(module) {
    return Array.from(module.sources, async (source) => [
      source,
      (module.resolvedIds[source] =
        module.resolvedIds[source] ||
            this.handleResolveId(await this.resolveId(source, module.id, EMPTY_OBJECT, false), source, module.id))
    ]);
  }
  getResolveDynamicImportPromises(module) {
    return module.dynamicImports.map(async (dynamicImport) => {
      const resolvedId = await this.resolveDynamicImport(module, typeof dynamicImport.argument === 'string'
        ? dynamicImport.argument
        : dynamicImport.argument.esTreeNode, module.id);
      if (resolvedId && typeof resolvedId === 'object') {
        dynamicImport.id = resolvedId.id;
      }
      return [dynamicImport, resolvedId];
    });
  }
  async fetchModule({ id, meta, moduleSideEffects, syntheticNamedExports }, importer, isEntry, isPreload) {
    const loadPromise = this.addModuleSource(id, importer, module).then(() => [
      // 获取子依赖模块路径
      this.getResolveStaticDependencyPromises(module),
      // 获取子依赖模块动态路径
      this.getResolveDynamicImportPromises(module),
      // 加载子模块依赖路径解析完成的标志，会触发 moduleParsed 钩子( 意味着当前模块解析完成(自身模块 + 子依赖模块路径) )。
      loadAndResolveDependenciesPromise
    ]);
    const loadAndResolveDependenciesPromise = waitForDependencyResolution(loadPromise).then(() => this.pluginDriver.hookParallel('moduleParsed', [module.info]));
    // ...
  }
}
```

子依赖模块路径解析完成之后就进入子模块构建的阶段

**代码简略如下：**

```js
class ModuleLoader {
  async fetchModule({ id, meta, moduleSideEffects, syntheticNamedExports }, importer, isEntry, isPreload) {
    // ...
    const resolveDependencyPromises = await loadPromise;
    if (!isPreload) {
      // 构建当前模块所有子模块依赖。
      await this.fetchModuleDependencies(module, ...resolveDependencyPromises);
    }
    // ...
  }
  async fetchModuleDependencies(module, resolveStaticDependencyPromises, resolveDynamicDependencyPromises, loadAndResolveDependenciesPromise) {
    // 如果当前模块已经处于解析子依赖模块的情况下就不进行后续处理。
    if (this.modulesWithLoadedDependencies.has(module)) {
      return;
    }
    // 标记当前模块进入构建子依赖模块阶段。
    this.modulesWithLoadedDependencies.add(module);
    // rollup 在构建子依赖模块的时候会区分子依赖模块的导入方式(静态导入或动态导入)。
    await Promise.all([
      this.fetchStaticDependencies(module, resolveStaticDependencyPromises),
      this.fetchDynamicDependencies(module, resolveDynamicDependencyPromises)
    ]);
    // ...
  }
  fetchResolvedDependency(source, importer, resolvedId) {
    // 对于外部模块则有专门的处理方案，不需要进行 fetchModule 流程。
    if (resolvedId.external) {
      const { external, id, moduleSideEffects, meta } = resolvedId;
      if (!this.modulesById.has(id)) {
        this.modulesById.set(id, new ExternalModule(this.options, id, moduleSideEffects, meta, external !== 'absolute' && isAbsolute(id)));
      }
      const externalModule = this.modulesById.get(id);
      if (!(externalModule instanceof ExternalModule)) {
        return error(errInternalIdCannotBeExternal(source, importer));
      }
      return Promise.resolve(externalModule);
    }
    return this.fetchModule(resolvedId, importer, false, false);
  }
  async fetchStaticDependencies(module, resolveStaticDependencyPromises) {
    for (const dependency of await Promise.all(resolveStaticDependencyPromises.map(resolveStaticDependencyPromise => resolveStaticDependencyPromise.then(([source, resolvedId]) => this.fetchResolvedDependency(source, module.id, resolvedId))))) {
      // 当前模块绑定与子依赖模块之间的依赖关系，即 module 模块依赖哪些静态模块。
      module.dependencies.add(dependency);
      // 子依赖模块绑定和父模块之间的依赖关系，即 dependency 模块被哪些静态模块所引用。
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
  async fetchDynamicDependencies(module, resolveDynamicImportPromises) {
    const dependencies = await Promise.all(resolveDynamicImportPromises.map(resolveDynamicImportPromise => resolveDynamicImportPromise.then(async ([dynamicImport, resolvedId]) => {
      // 如果解析路径不存在则无需后续流程
      if (resolvedId === null)
        return null;
      if (typeof resolvedId === 'string') {
        dynamicImport.resolution = resolvedId;
        return null;
      }
      return (dynamicImport.resolution = await this.fetchResolvedDependency(relativeId(resolvedId.id), module.id, resolvedId));
    })));
    for (const dependency of dependencies) {
      if (dependency) {
        // 当前模块绑定与子依赖模块之间的依赖关系，即 module 模块依赖哪些动态模块。
        module.dynamicDependencies.add(dependency);
        // 子依赖模块绑定和父模块之间的依赖关系，即 dependency 模块被哪些静态模块所引用。
        dependency.dynamicImporters.push(module.id);
      }
    }
  }
}
```

::: tip 总结
  静态导入和动态导入作为当前模块子依赖解析的入口，`rollup` 区分了两者导入的差异，这也是为了后续生成独立 `chunk` 做了层铺垫。最终依旧是 **递归(深度优先搜索)** 方式调用 `this.fetchModule(resolvedId, importer, false, false)` 来加载及构建子依赖模块信息。这里需要注意的是子依赖模块执行 `fetchModule` 的时候携带的 `entry` 值为 `false`，即表明模块为非入口模块。
:::

### 依赖关系的确定

并发获取子依赖模块之后就可以绑定模块与子依赖模块之间的关系，静态导入模块和动态导入模块绑定的属性会有所区别。

**代码简略如下：**

```js
class ModuleLoader {
  async fetchStaticDependencies(module, resolveStaticDependencyPromises) {
    for (const dependency of await Promise.all(resolveStaticDependencyPromises.map(resolveStaticDependencyPromise => resolveStaticDependencyPromise.then(([source, resolvedId]) => this.fetchResolvedDependency(source, module.id, resolvedId))))) {
      // 当前模块绑定与子依赖模块之间的依赖关系，即 module 模块依赖哪些静态模块。
      module.dependencies.add(dependency);
      // 子依赖模块绑定和父模块之间的依赖关系，即 dependency 模块被哪些静态模块所引用。
      dependency.importers.push(module.id);
    }
    // ...
  }
  async fetchDynamicDependencies(module, resolveDynamicImportPromises) {
    // ...
    for (const dependency of dependencies) {
      if (dependency) {
        // 当前模块绑定与子依赖模块之间的依赖关系，即 module 模块依赖哪些动态模块。
        module.dynamicDependencies.add(dependency);
        // 子依赖模块绑定和父模块之间的依赖关系，即 dependency 模块被哪些静态模块所引用。
        dependency.dynamicImporters.push(module.id);
      }
    }
  }
}
```


## 开发环境中
