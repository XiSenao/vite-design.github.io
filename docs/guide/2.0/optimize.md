---
sidebarDepth: 3
---
# 预构建流程

本篇章将讲述 Vite3.0 版本在预构建过程中所做的一些工作。

## 功能总览

Vite3.0 相比于 Vite2.0 来说在预构建流程上有了一定的优化，在开发阶段不阻塞 `server` 的启动。
Vite2.0 虽然底层代码跟 1.0 比改动很大，但总体理念和使用方式目前看起来差别不大。

Vite2.0 在底层代码的改动较大的地方大概是使用了 http + [connect](https://github.com/senchalabs/connect) 模块来代替 1.0 中的直接使用 koa 框架的一些能力。并且预优化的工具也由 rollup 的 [commonjs 插件](https://github.com/rollup/plugins/tree/master/packages/commonjs)替换为 [esbuild](https://esbuild.github.io/api/)。  
在 1.0 的使用过程中我就发现了一些 rollup 的 commonjs 插件的一些 [bug](https://github.com/rollup/plugins/issues/556)，并且提了一些 issue 记录，但是后续由于忙着开发自己的 [SSR 框架](https://github.com/ykfe/ssr)去了, 就没怎么跟进后续的进展。现在看到 2.0 换成了 esbuild，不仅构建速度大大提升，相应的 bug 也少了不少。  
在正式阅读源码前，本来以为 Vite 只是做了模块格式 `format:esm` 的简单操作，但是仔细阅读之后发现 Vite 做的工作还是不少的。这里大力推荐大家阅读一下 Vite2.0 的代码无论是仓库规范还是具体编码都是非常优秀值得大家学习的，且体量不大易于调试，比 Webpack 这些巨无霸级别的工具估计连作者自己都没办法掌握所有代码的要好得多。

## 本地调试

调试方式与 1.0 大体没有变化，只是 2.0 的架构变成了 monorepo 的形式，当然我们不需要管其他的 package，只需要调试 Vite 即可。

```bash
git clone git@github.com:vitejs/vite.git
cd vite && yarn
cd packages/vite && yarn build && yarn link
yarn dev
```

然后再通过 Vite 脚手架创建一个最简单的 example 来 link Vite

```bash
npm init @vitejs/app demo --template vue
cd demo && yarn && yarn link vite
npx vite optimize --force
```

然后就可以开始愉快的调试源码了

## vite 对于 esbuild 的使用

```ts
// vite/src/node/optimizer/index.ts

const { plugins = [], ...esbuildOptions } = config.optimizeDeps?.esbuildOptions ?? {}
const result = await build({
  absWorkingDir: process.cwd(),
  entryPoints: Object.keys(flatIdDeps),
  bundle: true,
  // We can't use platform 'neutral', as esbuild has custom handling
  // when the platform is 'node' or 'browser' that can't be emulated
  // by using mainFields and conditions
  platform:
    config.build.ssr && config.ssr?.target !== 'webworker'
      ? 'node'
      : 'browser',
  define,
  format: 'esm',
  target: isBuild ? config.build.target || undefined : ESBUILD_MODULES_TARGET,
  external: config.optimizeDeps?.exclude,
  logLevel: 'error',
  splitting: true,
  sourcemap: true,
  outdir: processingCacheDir,
  ignoreAnnotations: !isBuild,
  metafile: true,
  plugins: [
    ...plugins,
    esbuildDepPlugin(flatIdDeps, flatIdToExports, config)
  ],
  ...esbuildOptions,
  supported: {
    'dynamic-import': true,
    'import-meta': true,
    ...esbuildOptions.supported
  }
})
```

以上代码是 `Vite` 借助 `esbuild` 的能力来进行预构建，以下简单过一下配置项。

### entryPoints

`esbuild` 处理依赖预构建的入口, `Vite` 在处理依赖预构建的时候会将 `bare id` 进行扁平化处理，若不进行扁平化, 那么 `react/jsx-runtime` 就会打包成如下形式

```bash
.vite
└── deps_build-dist
    ├── node_modules
    │   └── react
    │       ├── jsx-runtime.js
    │       └── jsx-runtime.js.map
    └── package.json
```

增加路径解析复杂度, 但是 `esbuild` 无法得知扁平化后的路径具体指的是哪个路径，因此通过 `vite:dep-pre-bundle` 插件来做模块路径映射到绝对路径的处理。因此 `entryPoints` 会影响打包产物的格式，而值得注意的是，在早期 `esbuild` 版本( `0.8.34` )中，`path` 会影响打包产物的格式，而 `entryPoints` 并不会起到影响作用。

```js
{
  'react_jsx-runtime': '/Users/Project/vite/packages/vite/demo/node_modules/react/jsx-runtime.js'
}
```

`Vite` 通过 `alias` 和 `vite:resolve` 插件来解析 `bare id` 并获取模块实际的绝对路径。


### bundle

`bundle: true` 表明 `esbuild` 会将模块的依赖与模块自身打包成一个模块。

### external

依赖外置，不需要处理的模块。这个选项在做服务端渲染或者应用体积优化的时候经常用到。举个例子当开启了这个选项并做了一些配置时。

```js
import * as React from 'react'
```

打包后的代码仍然保留这段代码，而不是将 react 的代码打包进来。

### format

`format: 'esm'` 表明 `esbuild` 输出模块格式为 `esm`。这里也可以为 `cjs`，`loadConfigFromFile` 加载配置文件的时候, 若配置模块为非 `esm` 模块，则会通过 `esbuild` 将模块打包成 `cjs`, 之后在 `loadConfigFromBundledFile` 中重写 `require.extensions['.js']` 来编译 `cjs` 模块，获取配置模块的信息。具体源码如下:

```js
// vite/packages/vite/src/node/config.ts

async function loadConfigFromBundledFile(fileName, bundledCode) {
  const realFileName = fs$l.realpathSync(fileName);
  const defaultLoader = _require.extensions['.js'];
  _require.extensions['.js'] = (module, filename) => {
    if (filename === realFileName) {
      module._compile(bundledCode, filename);
    }
    else {
      defaultLoader(module, filename);
    }
  };
  // clear cache in case of server restart
  delete _require.cache[_require.resolve(fileName)];
  const raw = _require(fileName);
  _require.extensions['.js'] = defaultLoader;
  return raw.__esModule ? raw.default : raw;
}
async function bundleConfigFile(fileName, isESM = false) {
  const importMetaUrlVarName = '__vite_injected_original_import_meta_url';
  const result = await build$3({
      absWorkingDir: process.cwd(),
      entryPoints: [fileName],
      outfile: 'out.js',
      write: false,
      platform: 'node',
      bundle: true,
      format: isESM ? 'esm' : 'cjs',
      sourcemap: 'inline',
      metafile: true,
      define: {
          'import.meta.url': importMetaUrlVarName
      },
      plugins: [
        {
          name: 'externalize-deps',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              const id = args.path;
              if (id[0] !== '.' && !path$o.isAbsolute(id)) {
                return {
                  external: true
                };
              }
            });
          }
        },
        {
          name: 'inject-file-scope-variables',
          setup(build) {
            build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
              const contents = await fs$l.promises.readFile(args.path, 'utf8');
              const injectValues = `const __dirname = ${JSON.stringify(path$o.dirname(args.path))};` +
                `const __filename = ${JSON.stringify(args.path)};` +
                `const ${importMetaUrlVarName} = ${JSON.stringify(pathToFileURL(args.path).href)};`;
              return {
                loader: isTS(args.path) ? 'ts' : 'js',
                contents: injectValues + contents
              };
            });
          }
        }
      ]
  });
  const { text } = result.outputFiles[0];
  return {
      code: text,
      dependencies: result.metafile ? Object.keys(result.metafile.inputs) : []
  };
}
if (!userConfig) {
    // Bundle config file and transpile it to cjs using esbuild.
    const bundled = await bundleConfigFile(resolvedPath);
    dependencies = bundled.dependencies;
    userConfig = await loadConfigFromBundledFile(resolvedPath, bundled.code);
    debug(`bundled config file loaded in ${getTime()}`);
}
```

### outdir

预优化的缓存文件夹，默认为 `node_modules/.vite`。

### plugins

`esbuildDepPlugin` 这个插件就是 Vite 在 esbuild 打包中最核心的逻辑了。让我们来看看他到底干了什么事情。  
在分析这个插件的源码之前，我们先看 esbuild 官方给的一个最简单的插件例子，来看看如何编写 esbuild 的插件，了解一个最基本的工作流程。

```js
let envPlugin = {
  name: 'env',
  setup(build) {
    build.onResolve({ filter: /^env$/ }, args => ({
      path: args.path,
      namespace: 'env-ns',
    }))
    build.onLoad({ filter: /.*/, namespace: 'env-ns' }, () => ({
      contents: JSON.stringify(process.env),
      loader: 'json',
    }))
  },
}

require('esbuild').build({
  entryPoints: ['app.js'],
  bundle: true,
  outfile: 'out.js',
  plugins: [envPlugin],
}).catch(() => process.exit(1))
```

这里我们编写了一个名字为 env 的插件。它干了什么事情呢，比如我们有下面的这一段源代码

```js
import { PATH } from 'env'
console.log(`PATH is ${PATH}`)
```

`esbuild` 在 `onResolve` 阶段通过正则匹配( `GoLang` )到了 `env` 这个我们想 `import` 的模块，并且把它交给了一个名为 `env-ns` 的虚拟模块做最终的处理。在 `env-ns` 中，我们将当前的 `process.env` 环境变量 `stringify` 成 `json` 字符串的形式返回给了 `contents`。也就是 `env` 这个模块，最终返回的就是 `process.env` 的值

简单了解 `esbuild` 插件的执行流程后，接下来可以看一下预构建流程中最重要的插件: **`esbuildDepPlugin`**。

### esbuildDepPlugin

#### 特定文件 external

第一个处理是对特定格式文件的 external 处理，因为这些文件 esbuild 要么无法处理要么不应该由它来处理，Vite 自身会有另外的专门针对这些类型文件的处理逻辑。

```js

const externalTypes = [
  'css',
  // supported pre-processor types
  'less',
  'sass',
  'scss',
  'styl',
  'stylus',
  'pcss',
  'postcss',
  // known SFC types
  'vue',
  'svelte',
  'marko',
  'astro',
  // JSX/TSX may be configured to be compiled differently from how esbuild
  // handles it by default, so exclude them as well
  'jsx',
  'tsx',
  ...KNOWN_ASSET_TYPES
];
const KNOWN_ASSET_TYPES = [
  // images
  'png',
  'jpe?g',
  'jfif',
  'pjpeg',
  'pjp',
  'gif',
  'svg',
  'ico',
  'webp',
  'avif',
  // media
  'mp4',
  'webm',
  'ogg',
  'mp3',
  'wav',
  'flac',
  'aac',
  // fonts
  'woff2?',
  'eot',
  'ttf',
  'otf',
  // other
  'webmanifest',
  'pdf',
  'txt'
];

// remove optimizable extensions from `externalTypes` list
const allExternalTypes = config.optimizeDeps.extensions
  ? externalTypes.filter((type) => !config.optimizeDeps.extensions?.includes('.' + type))
  : externalTypes;
const convertedExternalPrefix = 'vite-dep-pre-bundle-external:';

build.onResolve({
  filter: new RegExp(`\\.(` + allExternalTypes.join('|') + `)(\\?.*)?$`)
}, async ({ path: id, importer, kind }) => {
  // if the prefix exist, it is already converted to `import`, so set `external: true`
  if (id.startsWith(convertedExternalPrefix)) {
    return {
      path: id.slice(convertedExternalPrefix.length),
      external: true
    };
  }
  const resolved = await resolve(id, importer, kind);
  if (resolved) {
    // 如果当前模块是使用 require 来进行调用.
    if (kind === 'require-call') {
      // here it is not set to `external: true` to convert `require` to `import`
      return {
        path: resolved,
        namespace: externalWithConversionNamespace
      };
    }
    return {
      path: resolved,
      external: true
    };
  }
});

build.onLoad({ filter: /./, namespace: externalWithConversionNamespace }, (args) => {
  // import itself with prefix (this is the actual part of require-import conversion)
  // 外部模块改为通过重导出的方式来进行处理。
  return {
    contents: `export { default } from "${convertedExternalPrefix}${args.path}";` +
        `export * from "${convertedExternalPrefix}${args.path}";`,
    loader: 'js'
  };
});
```

一个模块被设置为 `external` 之后，模块的代码就不会被 `esbuild` 打包到产物中，而是作为外部依赖被引入。预构建产物不需要关心 `external` 的具体处理方式, 处理方案交由给 `Vite Plugins` 来进行统一处理。

**源代码:**

```js
import './style.css';
const getValue = require('./demo1');
console.log('getValue: ', getValue);
```

**打包后:**

```js
import {
  __esm,
  __toCommonJS
} from "./chunk-MPUXO6CG.js";

// src/demo1.js
var demo1_exports = {};
var init_demo1 = __esm({
  "src/demo1.js"() {
    "use strict";
    module.exports = {
      add: (a, b) => {
        return a + b;
      }
    };
  }
});

// src/commonjs.js
import "/Users/chenjiaxiang/Project/vite/packages/vite/demo/src/style.css";
var getValue = (init_demo1(), __toCommonJS(demo1_exports));
console.log("getValue: ", getValue);
//# sourceMappingURL=___src_commonjs__js.js.map
```

可以看出 `css` 模块只是单纯的使用 `import` 导入模块的绝对路径，并没有做多余的处理。


#### 区分入口模块和依赖模块

Vite 对入口模块和依赖模块使用了不同的处理规则，入口模块指依赖预构建的模块。而依赖模块则是入口模块自身的依赖也就是 dependencies
这里可以看到如果是入口模块，则交给 `namespace` 为 `dep` 的虚拟模块来进行处理，且我们只返回一个 `flatId` 作为模块的 `path`(历史原因, 下面有做解释)。

```js
function resolveEntry(id: string) {
  const flatId = flattenId(id)
  if (flatId in qualified) {
    return {
      path: flatId,
      namespace: 'dep'
    }
  }
}


build.onResolve(
  { filter: /^[\w@][^:]/ },
  async ({ path: id, importer, kind }) => {
    // 过滤 config.optimizeDeps?.exclude 中所包含的模块
    if (moduleListContains(config.optimizeDeps?.exclude, id)) {
      return {
        path: id,
        external: true
      }
    }

    // ensure esbuild uses our resolved entries
    let entry: { path: string; namespace: string } | undefined
    // if this is an entry, return entry namespace resolve result
    if (!importer) {
      if ((entry = resolveEntry(id))) return entry
      // check if this is aliased to an entry - also return entry namespace
      const aliased = await _resolve(id, undefined, true)
      if (aliased && (entry = resolveEntry(aliased))) {
        return entry
      }
    }

    // use vite's own resolver
    const resolved = await resolve(id, importer, kind)
    if (resolved) {
      return resolveResult(id, resolved)
    }
  }
)
```

#### 模块路径的解析

从上面可以发现 `esbuild` 对于模块路径的解析存在 `_resolve` 和 `resolve` 这两种方案。

```js
// default resolver which prefers ESM

const _resolve = config.createResolver({ asSrc: false, scan: true })
// create an internal resolver to be used in special scenarios, e.g.
// optimizer & handling css @imports
const createResolver = (options) => {
  container =
    resolverContainer ||
      (resolverContainer = await createPluginContainer({
        ...resolved,
        plugins: [
          alias$1({ entries: resolved.resolve.alias }),
          resolvePlugin({
            ...resolved.resolve,
            root: resolvedRoot,
            isProduction,
            isBuild: command === 'build',
            ssrConfig: resolved.ssr,
            asSrc: true,
            preferRelative: false,
            tryIndex: true,
            ...options
          })
        ]
      }));
  return (await container.resolveId(id, importer, { ssr }))?.id;
}
```

可以看出 `_resolve` 处理模块的路径依赖于 `alias` 和 `vite:resolve` 两大插件来进行顺序处理。当然分析 `resolve` 处理模块路径也是同 `_resolve`，需要依赖 `alias` 和 `vite:resolve` 两大插件。

**alias 插件处理流程:**
其实 `alias` 处理流程很简单，本质上就是处理用户 alias 配置项并替换掉模块路径的过程。

```js
resolveId(importee, importer, resolveOptions) {
    if (!importer) {
      return null;
    }
    // First match is supposed to be the correct one
    const matchedEntry = config.resolve.alias.find((entry) => matches(entry.find, importee));
    if (!matchedEntry) {
      return null;
    }
    // 将 /@vite/client 替换成 /Users/Project/vite/packages/vite/dist/client/client.mjs 路径.
    const updatedId = importee.replace(matchedEntry.find, matchedEntry.replacement);
    // 若配置项中有配置 resolverFunction，那么就调用 resolverFunction 来对更换过的路径做处理，否则继续调用后续插件的 resolveId hook 做处理.
    if (matchedEntry.resolverFunction) {
      return matchedEntry.resolverFunction.call(this, updatedId, importer, resolveOptions);
    }
    return this.resolve(
            updatedId, 
            importer, 
            Object.assign({ skipSelf: true }, 
            resolveOptions
          ))
          .then((resolved) => resolved || { id: updatedId });
}
```

**vite:resolve 插件处理流程:**
这是 `Vite` 处理模块路径核心的插件，几乎所有重要的 Vite 特性都离不开这个插件的实现，诸如依赖预构建、HMR、SSR 等等。

+ commonjs代理模块的快速路径处理

  ```js
  if (/\?commonjs/.test(id) || id === 'commonjsHelpers.js') {
    return;
  }
  ```

+ 对于预构建模块路径的处理

  ```js
  // resolve pre-bundled deps requests, these could be resolved by
  // tryFileResolve or /fs/ resolution but these files may not yet
  // exists if we are in the middle of a deps re-processing
  if (asSrc && depsOptimizer?.isOptimizedDepUrl(id)) {
    const optimizedPath = id.startsWith(FS_PREFIX)
        ? fsPathFromId(id)
        : normalizePath$3(ensureVolumeInPath(path$o.resolve(root, id.slice(1))));
    return optimizedPath;
  }
  ```

+ 对于以 **`/@fs/*`** 开头的路径处理

  ```js
    if (asSrc && id.startsWith(FS_PREFIX)) {
      const fsPath = fsPathFromId(id);
      res = tryFsResolve(fsPath, options);
      // always return here even if res doesn't exist since /@fs/ is explicit
      // if the file doesn't exist it should be a 404
      return res || fsPath;
    }
  ```

+ 对于以 **`/`** 开头的路径做处理

  ```js
    if (asSrc && id.startsWith('/')) {
      const fsPath = path$o.resolve(root, id.slice(1));
      if ((res = tryFsResolve(fsPath, options))) {
        return res;
      }
    }
  ```

+ 对于以 **`.`** 或父模块以 **`.html`** 结尾的路径做处理

+ 对于绝对路径做处理
+ 对于以 `http` 或 `https` 引入的路径做处理
+ 对于 `data` url做处理
+ 对于 `Bare Import` 做处理
  + 这里会去检测路径是否归属于预构建模块，若是的话则会通过 `depsOptimizer.registerMissingImport(id, resolved, ssr)` 为 `metadata.discovered` 添加新的预构建模块。

#### dep虚拟模块

这块的工作基本上是预优化的核心内容。这里 Vite 只干了一件事情，就是生成了一个虚拟模块来导出原模块的原始 id。
举个例子，上面我们提到了 Vite 会把入口模块交给 namespace 为 `dep` 的流程去做进一步的处理。且只传递给了一个最原始的 Bare id (代码中引入的模块, `import runtime from 'react/jsx-runtime'`, `react/jsx-runtime` 即为 Bare id )。
Vite 在处理预构建模块的时候会获取模块的 `exportData` (导入和导出信息), 通过 `es-module-lexer` 包来获取模块的导入和导出信息，不过需要注意的是, `es-module-lexer` 包在处理含 `jsx` 模块的时候会报错, 因此 Vite 在解析报错的时候(`catch` 到)会通过 `esbuild` 配置 jsx loader 来解析 `jsx` 模块, `transfrom` 完成之后再使用 `es-module-lexer` 包解析模块获取模块的导入和导出信息。
当入口模块即没有 `import` 关键字 也没有 `export` 关键字时，我们认为它是一个 `cjs` 模块。生成的代理模块的格式如下:

```js
contents += `export default require("${relativePath}");`
```

当入口模块使用 `export default` 进行导出时，我们生成的代理模块的格式如下

```js
contents += `import d from "${relativePath}";export default d;`
```

当入口模块存在 `ReExports` 时，比如 `export * from './xxx.js'` 或者 `export` 关键字出现的次数大于1，或者不存在 `export default`的时候生成的代理模块的格式如下
这也是大多数符合标准的模块最终处理完成的格式。

```js
contents += `\nexport * from "${relativePath}"`
```

以 Vue 为例，当我们处理完之后。执行 `import Vue from 'vue'` 时，`'vue'` 实际返回的 contents 是 `export * from "./node_modules/vue/dist/vue.runtime.esm-bundler.js"`

具体源码如下

```js
const root = path.resolve(config.root)
build.onLoad({ filter: /.*/, namespace: 'dep' }, ({ path: id }) => {
  const entryFile = qualified[id]
  let relativePath = normalizePath(path.relative(root, entryFile))
  if (!relativePath.startsWith('.')) {
    relativePath = `./${relativePath}`
  }

  let contents = ''
  const data = exportsData[id]
  const [imports, exports] = data
  if (!imports.length && !exports.length) {
    // cjs
    contents += `export default require("${relativePath}");`
  } else {
    if (exports.includes('default')) {
      contents += `import d from "${relativePath}";export default d;`
    }
    if (
      data.hasReExports ||
      exports.length > 1 ||
      exports[0] !== 'default'
    ) {
      contents += `\nexport * from "${relativePath}"`
    }
  }

  let ext = path.extname(entryFile).slice(1)
  if (ext === 'mjs') ext = 'js'

  return {
    loader: ext as Loader,
    contents,
    resolveDir: root
  }
})
```

##### 到这肯定会有很大一部分疑惑，为什么需要专门设计虚拟模块(dep)来进行处理呢?

通过以下注释

```js
// For entry files, we'll read it ourselves and construct a proxy module
// to retain the entry's raw id instead of file path so that esbuild
// outputs desired output file structure.
// It is necessary to do the re-exporting to separate the virtual proxy
// module from the actual module since the actual module may get
// referenced via relative imports - if we don't separate the proxy and
// the actual module, esbuild will create duplicated copies of the same
// module!
```

我们可以看出这样设计的目的有两个

+ 使 `esbuild` 最终输出符合期望的结构
+ 如果不分离虚拟模块和真实模块，`esbuild` 可能会重复打包相同模块

经过测试可以发现在 `esbuild` 新版本( `0.15.10` )中，产物输出的结构和 `entryPoints` 有关，因此通过插件直接重写路径(具体的模块路径)不会出现输出结构不符合期望的问题而也不会存在重复打包模块的问题。但是针对注释所处的 `esbuild` 版本( `0.8.34` )来说，测试的时候发现输出的结构和 `path` 有关系，因此不能直接通过插件重写路径，会存在非扁平化的效果，那么就想不改变 `path`，`path` 依旧为扁平化，通过 `load hook` 来读取模块的信息。结果通过 `fs` 读模块对于 `esbuild` 来说不可感知是否是同一模块，因此会导致打包重复产物的问题。那么 `fs` 这一条路就行不通了，后来就考虑可以通过重导出来的方式来进行 `load` 处理。这样就同时解决了产物非扁平化问题和重复打包模块的问题。
![预构建产物非扁平化](../../images/dep-unflatten.png)

```bash
.vite
└── deps_build-dist_temp
    ├── chunk-CE3JUPYM.js
    ....
    ├── chunk-UUP7NEEN.js.map
    ├── node_modules
    │   └── react
    │       ├── index.js
    │       ├── index.js.map
    │       ├── jsx-dev-runtime.js
    │       ├── jsx-dev-runtime.js.map
    │       ├── jsx-runtime.js
    │       └── jsx-runtime.js.map
    ├── package.json
    └── src
        ├── commonjs.js
        ├── commonjs.js.map
        ├── demo.js
        ├── demo.js.map
        ├── demo1.js
        └── demo1.js.map
```


## 预构建流程

### 生产环境

#### 判断是否需要开启预构建流程

```js
function isDepsOptimizerEnabled(config) {
  const { command, optimizeDeps } = config;
  const { disabled } = optimizeDeps;
  return !(disabled === true ||
      (command === 'build' && disabled === 'build') ||
      (command === 'serve' && optimizeDeps.disabled === 'dev'));
}
```

需要注意的点是当在配置项中设置了 `resolved.legacy?.buildRollupPluginCommonjs`(借助 `commonjs` 插件的能力将 `cjs` 转换为 `esm` )

```js
// vite/packages/vite/demo/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // 借助 commonjs 插件的能力将 cjs 转换为 esm.
    commonjsOptions: {
      include: [/.\/src\/commonjs.js/, /node_modules/]
    }
  },
  legacy: {
    // 不建议使用，现阶段处理即将废弃的阶段。
    buildRollupPluginCommonjs: true
  }
})

// vite/packages/vite/src/node/config.ts
if (resolved.legacy?.buildRollupPluginCommonjs) {
  const optimizerDisabled = resolved.optimizeDeps.disabled;
  if (!optimizerDisabled) {
    resolved.optimizeDeps.disabled = 'build';
  }
  else if (optimizerDisabled === 'dev') {
    resolved.optimizeDeps.disabled = true; // Also disabled during build
  }
}
```

那么会使得 `resolved.optimizeDeps.disabled = 'build'`, 从而停止预构建流程。也就是说在 `Vite` 中，可以使用 `commonjs` 插件来对 `cjs` 转 `esm` 做处理或者使用 `esbuild` 来对 `cjs` 模块做打包处理。但值得注意的是在 `Vite 1.x` 版本中 `rollup` 的 `commonjs` 插件存在一些 [bug](https://github.com/rollup/plugins/issues/556)，因此 `Vite` 推荐使用 `esbuild` 来做统一处理。

#### metadata配置文件的处理

读取缓存中的metadata配置文件

```js
function loadCachedDepOptimizationMetadata(config, force = config.optimizeDeps.force, asCommand = false, ssr = !!config.build.ssr) {
    const log = asCommand ? config.logger.info : debug$a;
    // Before Vite 2.9, dependencies were cached in the root of the cacheDir
    // For compat, we remove the cache if we find the old structure
    if (fs$l.existsSync(path$o.join(config.cacheDir, '_metadata.json'))) {
        emptyDir(config.cacheDir);
    }
    /**
     * 获取依赖预构建产物存储的文件夹
     * build:
     * /Users/Project/vite/packages/vite/demo/node_modules/.vite/deps_build-dist
     * dev:
     * /Users/Project/vite/packages/vite/demo/node_modules/.vite/deps
     */
    const depsCacheDir = getDepsCacheDir(config, ssr);
    /**
     * 若没有使用 --force 指令的情况下走这一条分支，因为预构建流程受到配置文件的影响，配置文件中部分信息变更或者首次预构建会开启预构建流程，
     * 否则的话会复用前一次预构建产物。使用 --force 指令则确定本次一定是预构建流程。
     */
    if (!force) {
        let cachedMetadata;
        try {
            // 获取 _metadata.json 的路径， cachedMetadataPath = ${depsCacheDir}/_metadata.json
            const cachedMetadataPath = path$o.join(depsCacheDir, '_metadata.json');
            // 借助 fs 的能力读取 _metadata.json 并进行解析
            cachedMetadata = parseDepsOptimizerMetadata(fs$l.readFileSync(cachedMetadataPath, 'utf-8'), depsCacheDir);
        }
        catch (e) { }
        // 比较缓存的 hash 与当前的 hash，hash 不变的话则复用原先的预构建产物。
        if (cachedMetadata && cachedMetadata.hash === getDepHash(config)) {
            log('Hash is consistent. Skipping. Use --force to override.');
            // Nothing to commit or cancel as we are using the cache, we only
            // need to resolve the processing promise so requests can move on
            return cachedMetadata;
        }
    }
    else {
        config.logger.info('Forced re-optimization of dependencies');
    }
    // 借助 fs 的能力同步删除原先预构建产物，开启预构建流程。
    fs$l.rmSync(depsCacheDir, { recursive: true, force: true });
}
```

这里需要关注的点是 `getDepHash`，`config` 的哪些因素会导致缓存失效。

```js
function getDepHash(config) {
  const lockfileFormats = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
  // 借助 fs 的能力读取 lockfile 文件信息
  let content = lookupFile(config.root, lockfileFormats) || '';
  // also take config into account
  // only a subset of config options that can affect dep optimization
  content += JSON.stringify({
      mode: process.env.NODE_ENV || config.mode,
      root: config.root,
      resolve: config.resolve,
      buildTarget: config.build.target,
      assetsInclude: config.assetsInclude,
      plugins: config.plugins.map((p) => p.name),
      optimizeDeps: {
          include: config.optimizeDeps?.include,
          exclude: config.optimizeDeps?.exclude,
          esbuildOptions: {
              ...config.optimizeDeps?.esbuildOptions,
              plugins: config.optimizeDeps?.esbuildOptions?.plugins?.map((p) => p.name)
          }
      }
  }, (_, value) => {
      if (typeof value === 'function' || value instanceof RegExp) {
          return value.toString();
      }
      return value;
  });
  return createHash$2('sha256').update(content).digest('hex').substring(0, 8);
}
```

从上面可以得知，缓存是否失效取决于以下几点因素:

+ `lockfile` 是否发生变动, 即是否新增依赖。
+ `mode` 模式是否发生变更, 例如从 `production` 改为了 `development`。
+ `resolve` 是否发生变动, `alias` 等配置项。
+ `buildTarget` 打包的目标环境是否发生变动，默认打包的目标环境为 `['es2020', 'edge88', 'firefox78', 'chrome87', 'safari13']`。
+ `assetsInclude` 对于静态资源的判定是否发生变动。
+ `plugins` 插件是否在顺序或数量上发生变化。
+ `optimizeDeps`
  + `include` 需要进行依赖预构建的的入口是否发生变化。
  + `exclude` 不需要进行依赖预构建的的入口是否发生变化。
  + `esbuildOptions` `esbuild` 的配置项是否发生变化。

```js
function getDepsOptimizer(config) {
    // Workers compilation shares the DepsOptimizer from the main build
    return depsOptimizerMap.get(config.mainConfig || config);
}
const cachedMetadata = loadCachedDepOptimizationMetadata(config);
let _metadata = cachedMetadata || initDepsOptimizerMetadata(config, sessionTimestamp);
const depsOptimizer = {
    // 获取当前构建流程的 metadata 信息。
    metadata: (options) => {
      if (isBuild || !options.ssr) {
        return _metadata;
      }
      else {
        return ssrServerDepsMetadata;
      }
    },
    /**
     * 用来添加缺失的预构建模块，与 vite:resolve 插件所关联。
     * 在检索模块路径的时候发现为路径归属于预构建模块则会通过该 hook 来添加缺失的预构建模块。
     *  */ 
    registerMissingImport,
    /**
     * 开启预构建流程，预构建流程会等到项目中所有模块均 resolve 后才会进行调用，
     * 原因是为了发掘项目中可能潜在需要预构建的模块。
     */
    run: () => debouncedProcessing(0),
    // 判断是否是依赖预构建的模块
    isOptimizedDepFile: (id) => isOptimizedDepFile(id, config),
    isOptimizedDepUrl: createIsOptimizedDepUrl(config),
    // 获取依赖预构建产物的绝对路径。由于预构建流程会延后执行，直接通过 resolve plugin 是无法进行解析的。 
    getOptimizedDepId: (depInfo) => isBuild ? depInfo.file : `${depInfo.file}?v=${depInfo.browserHash}`,
    registerWorkersSource,
    delayDepsOptimizerUntil,
    resetRegisteredIds,
    ensureFirstRun,
    options: config.optimizeDeps
};
// 初始化 depsOptimizer，配置 config 和 depsOptimizer 之间的映射关系。在后续获取当前 depsOptimizer 的时候可以通过 config 来获取。
depsOptimizerMap.set(config, depsOptimizer);
```

#### 预构建的准备

通过读取 `config.optimizeDeps?.include` 配置项来构建 `metadata.discovered`，即确认已知的预构建入口。代码如下:

```js
/**
 * 解析 config.optimizeDeps?.include 配置的目标预构建入口，
 * 获取 normalizedId 和 entry 之间的映射关系。
 */
async function addManuallyIncludedOptimizeDeps(deps, config, extra, filter) {
  const include = [...(config.optimizeDeps?.include ?? []), ...(extra ?? [])];
  if (include) {
    const resolve = config.createResolver({ asSrc: false, scan: true });
    for (const id of include) {
      // normalize 'foo   >bar` as 'foo > bar' to prevent same id being added
      // and for pretty printing
      const normalizedId = normalizeId(id);
      if (!deps[normalizedId] && filter?.(normalizedId) !== false) {
        // 依赖 alias 和 vite:resolve 插件来进行解析模块路径
        const entry = await resolve(id);
        if (entry) {
          deps[normalizedId] = entry;
        }
        else {
          throw new Error(`Failed to resolve force included dependency: ${picocolors.exports.cyan(id)}`);
        }
      }
    }
  }
}
// 构建 normalizedId 和 metadata.discovered 之间的映射关系
function toDiscoveredDependencies(config, deps, ssr, timestamp) {
  const browserHash = getOptimizedBrowserHash(getDepHash(config), deps, timestamp);
  const discovered = {};
  for (const id in deps) {
    const src = deps[id];
    discovered[id] = {
      id,
      file: getOptimizedDepPath(id, config, ssr),
      src,
      browserHash: browserHash,
      exportsData: extractExportsData(src, config)
    };
  }
  return discovered;
}
async function initialProjectDependencies(config, timestamp, knownDeps) {
  const deps = knownDeps ?? {};
  await addManuallyIncludedOptimizeDeps(deps, config);
  return toDiscoveredDependencies(config, deps, !!config.build.ssr, timestamp);
}
if (!cachedMetadata) {
  if (!scan) {
      // Initialize discovered deps with manually added optimizeDeps.include info
      const discovered = await initialProjectDependencies(config, sessionTimestamp);
      const metadata = _metadata;
      for (const depInfo of Object.values(discovered)) {
          addOptimizedDepInfo(metadata, 'discovered', {
              ...depInfo,
              processing: depOptimizationProcessing.promise
          });
      }
  }
  else {
    // Perform a esbuild base scan of user code to discover dependencies
  }
}
```

以上流程中需要额外关注的是 `exportsData` 的处理, 即解析模块导出和导入信息。主要借助 `es-module-lexer` 的能力来获取模块的导入导出信息，由于 `es-module-lexer` 无法处理 `jsx` 模块，因此还需要借助 `esbuild` 的能力来将 `jsx` 模块转化为 `js` 模块。源码流程如下:

```js
async function extractExportsData(filePath, config) {
  await init;
  const esbuildOptions = config.optimizeDeps?.esbuildOptions ?? {};
  if (config.optimizeDeps.extensions?.some((ext) => filePath.endsWith(ext))) {
    // For custom supported extensions, build the entry file to transform it into JS,
    // and then parse with es-module-lexer. Note that the `bundle` option is not `true`,
    // so only the entry file is being transformed.
    const result = await build$3({
      ...esbuildOptions,
      entryPoints: [filePath],
      write: false,
      format: 'esm'
    });
    const [imports, exports, facade] = parse$b(result.outputFiles[0].text);
    return {
      hasImports: imports.length > 0,
      exports,
      facade
    };
  }
  let parseResult;
  let usedJsxLoader = false;
  // 借助 fs 模块来获取模块的源码信息。
  const entryContent = fs$l.readFileSync(filePath, 'utf-8');
  try {
    // 借助 es-module-lexer 来解析模块信息，获取模块的导出和导入信息。
    parseResult = parse$b(entryContent);
  }
  catch {
    /**
     * 值得关注的是 es-module-lexer 对于 jsx 解析会报错, 
     * 因此这里需要借助 esbuild 的能力来将 jsx 转换为 js 模块,
     * 然后再借助于 es-module-lexer 的能力进行解析，获取模块的
     * 导入和导出信息。
     *  */ 
    const loader = esbuildOptions.loader?.[path$o.extname(filePath)] || 'jsx';
    debug$a(`Unable to parse: ${filePath}.\n Trying again with a ${loader} transform.`);
    const transformed = await transformWithEsbuild(entryContent, filePath, {
      loader
    });
    // Ensure that optimization won't fail by defaulting '.js' to the JSX parser.
    // This is useful for packages such as Gatsby.
    esbuildOptions.loader = {
      '.js': 'jsx',
      ...esbuildOptions.loader
    };
    parseResult = parse$b(transformed.code);
    usedJsxLoader = true;
  }
  const [imports, exports, facade] = parseResult;
  const exportsData = {
    // 模块中是否含 import 依赖其他模块
    hasImports: imports.length > 0,
    // 模块中是否含 exports 导出能力
    exports,
    // 是否为虚假模块或重导出模块，即模块里面只包含 import 和 export，而不包含其他能力。
    facade,
    // 是否模块中包含重导出信息
    hasReExports: imports.some(({ ss, se }) => {
      const exp = entryContent.slice(ss, se);
      return /export\s+\*\s+from/.test(exp);
    }),
    // 模块是否为 jsx 模块
    jsxLoader: usedJsxLoader
  };
  return exportsData;
}
```

对于整个 `Vite` 项目有所了解的同学可能会有所疑惑，为什么在 `vite:build-import-analysis` 插件的 `transform` 阶段不需要额外处理 `jsx` 场景而是直接使用 `es-module-lexer` 的能力呢?  

**`vite:build-import-analysis` 插件源码简略版如下:**

```js
function buildImportAnalysisPlugin(config) {
  ...
  return {
    name: 'vite:build-import-analysis',
    async transform(source, importer) {
      if (importer.includes('node_modules') &&
        !dynamicImportPrefixRE.test(source)) {
        return;
      }
      await init;
      let imports = [];
      try {
        imports = parse$b(source)[0];
      }
      catch (e) {
        this.error(e, e.idx);
      }
      ...
    }
  }
}
```

想要了解原因就需要对 `Vite` 内置的插件体系有所了解, `Vite` 按执行顺序将插件分为三大类, `pre`、`normal`、`post`，执行 `transform` hook 会从前往后依次执行。

**以下是 `Vite` 注入的内置插件:**

```js
export function resolveBuildPlugins(config: ResolvedConfig): {
  pre: Plugin[]
  post: Plugin[]
} {
  const options = config.build

  return {
    pre: [
      ...(options.watch ? [ensureWatchPlugin()] : []),
      watchPackageDataPlugin(config),
      commonjsPlugin(options.commonjsOptions),
      dataURIPlugin(),
      assetImportMetaUrlPlugin(config),
      ...(options.rollupOptions.plugins
        ? (options.rollupOptions.plugins.filter(Boolean) as Plugin[])
        : [])
    ],
    post: [
      buildImportAnalysisPlugin(config),
      ...(config.esbuild !== false ? [buildEsbuildPlugin(config)] : []),
      ...(options.minify ? [terserPlugin(config)] : []),
      ...(options.manifest ? [manifestPlugin(config)] : []),
      ...(options.ssrManifest ? [ssrManifestPlugin(config)] : []),
      buildReporterPlugin(config),
      loadFallbackPlugin()
    ]
  }
}

```

可以得知 `Vite` 在布局内部插件的时候将 `buildImportAnalysisPlugin` 归纳为 `post` 插件。当处理 `jsx` 插件为外部插件, 归类为 `normalPlugins`。因此 `jsx transfrom` 执行时机一定是早于 `vite:build-import-analysis` 插件中的 `transfrom` hook。也就是说在执行到`vite:build-import-analysis` 插件中 `transfrom` hook 就已经将 `jsx` 模块解析完成。因此 `vite:build-import-analysis` 插件就不需要额外关注 `jsx` 模块。但是在处理依赖预构建的 `extractExportsData` 的时候，`jsx` 对应的 `transfrom` 就没执行，则需要借助 `esbuild` 来做 `transfrom` 操作, 将 `jsx` 转换为 `js` 模块。

**小结:**
由上可以得知，预构建准备流程十分简单。在开发阶段流程大致也是一样，不会阻塞 `server` 的启动，因此启动速度是很快的。

用 `tree` 来结构化表示如下:

```bash
预构建前的准备工作
    ├── `metadata` 的初始化
    │   └── `metadata`的缓存处理
    │       └── 缓存失效的判定
    └── `metadata.discovered` 依赖预构建的初始化
        └── `exportData` 的确定
            └──模块导入导出处理
                ├── 非 `jsx` 模块(`es-module-lexer`)
                └── `jsx` 模块(`esbuild + es-module-lexer`)
```

#### 检测潜在需要预构建的模块

其实大家也发现预构建准备阶段过于简单，只是单纯将配置项( `config.optimizeDeps.include` )作为预构建的目标。但是将项目中所有需要预构建的模块都一一配置就显得很是复杂，当然我们也没有这么做。我们可以发现我们没有配置项目中潜在需要预构建的模块项目也可以找到它们并且预构建出产物，那么 `Vite` 是如何做到的呢?

我们可以看下方代码

```js
// vite/packages/vite/src/node/plugins/resolve.ts

// this is a missing import, queue optimize-deps re-run and
// get a resolved its optimized info
const optimizedInfo = depsOptimizer.registerMissingImport(id, resolved, ssr);
resolved = depsOptimizer.getOptimizedDepId(optimizedInfo);
```

看注释就可以得知这里就是对于缺失的预构建模块做补偿处理。我们可以简单打一个断点来看一下具体流程吧。

![缺失预构建流程](../../images/missing-dep-line.png)

简单介绍一下流程，从上方断点处可以看到入口位置为 `fetchModule` 中的 `transfrom` 阶段

```js
module.setSource(await transform(sourceDescription, module, this.pluginDriver, this.options.onwarn));
```

上述 `transfrom` 函数中会去调用插件的 `transfrom` hook，在 `vite:build-import-analysis` 插件 `transfrom` 阶段会遍历当前模块所依赖的所有模块，并对依赖的模块路径 `resolve` 处理。
**简略版:**

```js
// vite/packages/vite/src/node/plugins/importAnalysisBuild.ts

async function normalizeUrl (url, pos) {
  // 父模块
  let importerFile = importer;
  const resolved = await this.resolve(url, importerFile);
  return [url, resolved.id];
}
function buildImportAnalysisPlugin(config) {
  return {
    name: 'vite:build-import-analysis',
    async transform(source, importer) {
      await init;
      let imports = [];
      try {
        imports = parse$b(source)[0];
      }
      for (let index = 0; index < imports.length; index++) {
        const { s: start, e: end, ss: expStart, se: expEnd, n: specifier, d: dynamicIndex } = imports[index];
        const [url, resolvedId] = await normalizeUrl(specifier, start);
      }
    }
  }
}
```

执行 `resolve` 函数则会调用所有插件的 `resolveId` hook， `vite:resolve` 插件在 `resolveId` 阶段会对 `Bare Import` 做 `tryNodeResolve` 处理。
**简略版:**

```js
function resolvePlugin(resolveOptions) {
  return {
    name: 'vite:resolve',
    async resolveId (id, importer, resolveOpts) {
      const bareImportRE = /^[\w@](?!.*:\/\/)/;
      if (bareImportRE.test(id)) {
        if ((res = tryNodeResolve(id, importer, options, targetWeb, depsOptimizer, ssr, external))) {
          return res;
        }
      }
    }
  }
}
```

`tryNodeResolve` 其中会判断当前路径是否需要进行预构建，若需要的话则执行 `depsOptimizer.registerMissingImport(id, resolved, ssr);` 来注册预构建入口。
**简略版:**

```js
if (
  !isJsType ||
  importer?.includes('node_modules') ||
  exclude?.includes(pkgId) ||
  exclude?.includes(nestedPath) ||
  SPECIAL_QUERY_RE.test(resolved) ||
  (!isBuild && ssr)
  ) {
      // ...
  } else {
    // this is a missing import, queue optimize-deps re-run and
    // get a resolved its optimized info
    const optimizedInfo = depsOptimizer.registerMissingImport(id, resolved, ssr);
    resolved = depsOptimizer.getOptimizedDepId(optimizedInfo);
  }
    
```

那么我们简单来看一下 `depsOptimizer.registerMissingImport(id, resolved, ssr)` 中具体做了什么

```js
function registerMissingImport(id, resolved, ssr) {
  if (depsOptimizer.scanProcessing) {
    config.logger.error('Vite internal error: registering missing import before initial scanning is over');
  }
  if (!isBuild && ssr) {
      config.logger.error(`Error: ${id} is a missing dependency in SSR dev server, it needs to be added to optimizeDeps.include`);
  }
  const metadata = _metadata;
  const optimized = metadata.optimized[id];
  // 如果模块已经构建完成则直接构建后的信息
  if (optimized) {
      return optimized;
  }
  const chunk = metadata.chunks[id];
  // 如果模块已经构建完成则直接构建后的信息
  if (chunk) {
      return chunk;
  }
  let missing = metadata.discovered[id];
  // 如果是路径已经被记录，那么也就直接方法信息
  if (missing) {
      // We are already discover this dependency
      // It will be processed in the next rerun call
      return missing;
  }
  newDepsDiscovered = true;
  // 给 metadata.discovered 中添加新发现的预构建入口。
  missing = addOptimizedDepInfo(metadata, 'discovered', {
      id,
      file: getOptimizedDepPath(id, config, ssr),
      src: resolved,
      // Assing a browserHash to this missing dependency that is unique to
      // the current state of known + missing deps. If its optimizeDeps run
      // doesn't alter the bundled files of previous known dependendencies,
      // we don't need a full reload and this browserHash will be kept
      browserHash: getDiscoveredBrowserHash(metadata.hash, depsFromOptimizedDepInfo(metadata.optimized), depsFromOptimizedDepInfo(metadata.discovered)),
      // loading of this pre-bundled dep needs to await for its processing
      // promise to be resolved
      processing: depOptimizationProcessing.promise,
      exportsData: extractExportsData(resolved, config)
  });
  // Until the first optimize run is called, avoid triggering processing
  // We'll wait until the user codebase is eagerly processed by Vite so
  // we can get a list of every missing dependency before giving to the
  // browser a dependency that may be outdated, thus avoiding full page reloads
  if (scan || firstRunCalled) {
      // Debounced rerun, let other missing dependencies be discovered before
      // the running next optimizeDeps
      debouncedProcessing();
  }
  // Return the path for the optimized bundle, this path is known before
  // esbuild is run to generate the pre-bundle
  return missing;
}
```

由以上源码可知 `registerMissingImport` 做的主要事情就是判断当前路径是否已经归属于预构建入口，若没有归属的话则将其添加为 `metadata.discovered` 作为即将预构建的入口。

#### 延迟预构建处理

我们已经了解了 `Vite` 在预构建流程中会使用补偿的机制来完善需要预构建的入口。那么我们可能会想预构建的流程什么时候才开始呢? 聪明的小伙伴可能会想一定需要将项目中所有模块都检索完成，发现所有潜在需要补偿的预构建入口，然后才能开始预构建处理。很棒，这个想法是没有错的! 那么接下来我们就来分析一下 `Vite` 是如何实现延迟预构建的。

当然分析延迟流程并不是很容易，因为无法了解入口点是什么，所以我们需要反向来进行分析。
我们可以从 [官方文档](https://cn.vitejs.dev/guide/dep-pre-bundling.html#automatic-dependency-discovery)
![自动以来搜寻](../../images/automatic-dependency-search-official.png)
中分析出预构建最终构建流程会借助 `esbuild` 的能力。我们很容易找出这一块的源码归属于 `runOptimizeDeps` 函数中，也就是最后构建的时候会调用 `runOptimizeDeps` 函数。那么我们打一个断点就可以清晰的了解整个预构建的流程(包括延迟执行)的流程。

**简略版:**

![预构建流程-上](../../images/pre-built-packaging-process-first.png)
![预构建流程-下](../../images/pre-built-packaging-process-second.png)

打断点后我们就可以很清晰的看清楚预构建的具体流程，我们可以发现还是在 `fetchModule` 中的 `transfrom` 阶段处理的。由断点可以发现具体是执行`vite:optimized-deps-build` 的 `transfrom`

**简略:**

```js
// packages/vite/src/node/plugins/optimizedDeps.ts

function optimizedDepsBuildPlugin(config) {
  return {
    name: 'vite:optimized-deps-build',
    transform(_code, id) {
      getDepsOptimizer(config)?.delayDepsOptimizerUntil(id, async () => {
        await this.load({ id });
      });
    },
  }
}

// packages/vite/src/node/optimizer/optimizer.ts

function delayDepsOptimizerUntil(id, done) {
  // 若模块还未构建完成且路径还没访问过
  if (!depsOptimizer.isOptimizedDepFile(id) && !seenIds.has(id)) {
    // 标记路径，表面已经访问过了。
    seenIds.add(id);
    // 注册任务, 需要注意的是这里的 done, 下面会做介绍。
    registeredIds.push({ id, done });
    // 执行延迟执行函数
    runOptimizerWhenIdle();
  }
  if (server && !optimizeDepsEntriesVisited) {
    optimizeDepsEntriesVisited = true;
    preTransformOptimizeDepsEntries(server);
  }
}

const runOptimizerIfIdleAfterMs = 100;
function runOptimizerWhenIdle() {
  if (!waitingOn) {
    const next = registeredIds.pop();
    if (next) {
      waitingOn = next.id;
      const afterLoad = () => {
        waitingOn = undefined;
        if (!firstRunCalled && !workersSources.has(next.id)) {
          if (registeredIds.length > 0) {
            runOptimizerWhenIdle();
          }
          else {
            getDepsOptimizer(config)?.run();
          }
        }
      };
      next
        .done()
        .then(() => {
          setTimeout(afterLoad, registeredIds.length > 0 ? 0 : runOptimizerIfIdleAfterMs);
        })
        .catch(afterLoad);
    }
  }
}
```

我们可以得知 `runOptimizerWhenIdle` 就是延迟预构建核心的代码, 从代码上我们可以看出会持续执行 `runOptimizerWhenIdle` 方法直到所有注册的待预构建入口都执行完 `next.done` 之后才进入真正的预构建流程 `getDepsOptimizer(config)?.run()`。那我们来看一下 `next.done` 具体做了什么，源码如下:

**简略版:**

```js
async handleExistingModule(module, isEntry, isPreload) {
  const loadPromise = this.moduleLoadPromises.get(module);
  if (isPreload) {
    return loadPromise;
  }
  // ...
}
async fetchModule({ id, meta, moduleSideEffects, syntheticNamedExports }, importer, isEntry, isPreload) {
  const existingModule = this.modulesById.get(id);
  if (existingModule instanceof Module) {
    await this.handleExistingModule(existingModule, isEntry, isPreload);
    return existingModule;
  }
  // ...
  const module = new Module(this.graph, id, this.options, isEntry, moduleSideEffects, syntheticNamedExports, meta);
  // 当前模块加载完成之后，获取模块的依赖模块，但不包含依赖模块的加载流程。
  const loadPromise = this.addModuleSource(id, importer, module).then(() => [
    this.getResolveStaticDependencyPromises(module),
    this.getResolveDynamicImportPromises(module),
    loadAndResolveDependenciesPromise
  ]);
  this.moduleLoadPromises.set(module, loadPromise);
  // ...
}
async preloadModule(resolvedId) {
  const module = await this.fetchModule(this.getResolvedIdWithDefaults(resolvedId), undefined, false, resolvedId.resolveDependencies ? RESOLVE_DEPENDENCIES : true);
  return module.info;
}
```

由上我们可以得知 `next.done` 中会执行 `preloadModule` 操作，在这个操作中需等待 `loadPromise` 解析完成后才会进入 `next.done` 的 `then` 流程。也就是说若想执行 `next.done().then` 的回调则需要等待当前 `waitingOn` 模块加载完成( `module.setSource(await transform(xx, xx, xx, xx));` ), 由上 `检测潜在需要预构建的模块` 中得知，在 `transfrom` 阶段会探测依赖模块是否符合预构建的条件，也就是收集当前模块中潜在预构建的入口。

> 延迟预构建的流程到此应该算是比较清晰。除了预构建模块，其余的模块都会执行 `fetchModule` 流程，而在此之前会先执行 `transfrom` 的操作，在 `vite:optimized-deps-build` 插件中会注册等待模块，预构建执行时机为所有注册项都解析完成后。这里可以看作一个 **`广度优先搜索`** 的流程。举个例子，
有如下 `tree` 的模块依赖关系:

```bash
index.html
    ├── chunk-a.js
    ├── ├── chunk-b-a.js
    ├── └── chunk-b-b.js
    └── chunk-b.js
```

+ `fetchModule` 获取 `index.html` 模块
+ `vite:optimized-deps-build` 插件中在 `transfrom` 阶段中注册 `index.html` 模块，即 `registeredIds = [index.html]`。
+ 执行 `registeredIds.pop()` 后 `registeredIds = []`
+ `index.html` 模块且包括 `子依赖模块路径` 解析完成
+ 进入回调并注册宏任务 `setTimeout(afterLoad, 100)`
+ `index.html` 中的所有 `子依赖模块` 完成 `reload`
+ `index.html` 中的所有 `子依赖模块` 完成 `transform`, 流程同第二步，即 `registeredIds = [chunk-a.js， chunk-b.js]`。
+ 执行 `registeredIds.pop()` 后 `registeredIds = [chunk-b.js]`
+ `chunk-a.js` 模块且包括 `子依赖模块路径` 解析完成
+ 进入回调并注册宏任务 `setTimeout(afterLoad, 0)`
+ `chunk-a.js` 中的所有 `子依赖模块` 完成 `reload`
+ `chunk-a.js` 中的所有 `子依赖模块` 完成 `transform`，流程同第二步，即 `registeredIds = [chunk-b.js， chunk-b-a.js， chunk-b-b.js]`
+ 流程同第 `8` 步依次循环执行，直至 `registeredIds = []`。
+ 执行 `getDepsOptimizer(config)?.run()` 正式进入预构建流程。

同时每次在 `transfrom` 阶段都会分析 `子依赖模块` 是否为潜在依赖预构建的模块并将其收集。

::: tip 小结
  延迟预构建处理流程本质上也是依赖预构建的主流程，代码逻辑稍微会绕一些。延迟预构建的目的是尽可能多的收集预构建入口，借助于 **`esbuild`** 的能力来一次性执行完预构建流程。当然在实际生产环境中，存在 **`加载模块的时机`** 在执行 **`预构建的时机`** 之后，从而导致会执行多次预构建流程。
:::

**思考:**

```js
function runOptimizerWhenIdle() {
  if (!waitingOn) {
    const next = registeredIds.pop()
    if (next) {
      waitingOn = next.id
      const afterLoad = () => {
        waitingOn = undefined
        if (!firstRunCalled && !workersSources.has(next.id)) {
          if (registeredIds.length > 0) {
            runOptimizerWhenIdle()
          } else {
            getDepsOptimizer(config)?.run()
          }
        }
      }
      next
        .done()
        .then(() => {
          setTimeout(
            afterLoad,
            registeredIds.length > 0 ? 0 : runOptimizerIfIdleAfterMs
          )
        })
        .catch(afterLoad)
    }
  }
}
```

从代码上看 `setTimeout` 这一块对于 `registeredIds.length === 0` 条件下会延迟 `100ms` 宏任务后执行。那么问题来了，假设加载 `index.html` 入口模块，那么在回调中 `registeredIds.length = 0`。模块的加载流程大体为 `resolveId -> reload -> transform -> registeredIds` 如果子依赖模块太大，那么就会导致 `reload` 的时间过长。可能存在执行 `afterLoad` 函数的时候 `registeredIds.length = 0`，那样的话就直接进入了 `getDepsOptimizer(config).run()` 预构建流程。而事实也是如此，若依赖子模块加载时间过长则会使得先进入预构建流程，不需要等待所有预构建模块都收集完成后执行预构建。针对 `100ms` 的宏任务时间主要的用途应该是延缓预构建执行流程，尽可能在 `100ms` 期间注册更多的模块。若在 `100ms` 期间内没有收集到模块，那么其他模块在 `transfrom` 阶段的时候依旧会进行注册然后再次执行 `runOptimizerWhenIdle`。

```bash
项目结构
index.html
    ├── vite/modulepreload-polyfill.js
    └── index.js (335.7 MB)
        └── react.js
            └── chunk.js

```

```bash
vite v3.0.0-beta.5 building for production...
index.html 模块开始获取信息
index.html 模块源码加载 --- 结束: 1.442ms
index.html 模块 transfrom 处理阶段 ---- 开始
transforming (1) index.html
index.html 模块 transfrom 处理阶段 ---- 结束
index.html 模块获取所有子依赖模块 ---- 开始
index.html  模块 loadPromise 解析完成, 剩余注册ID:  []
modulepreload-polyfill 模块开始获取信息
index.js 模块开始获取信息
modulepreload-polyfill 模块源码加载 --- 结束: 0.401ms
modulepreload-polyfill 模块 transfrom 处理阶段 ---- 开始
modulepreload-polyfill 模块 transfrom 处理阶段 ---- 结束
modulepreload-polyfill 模块获取所有子依赖模块 ---- 开始
modulepreload-polyfill 模块获取所有子依赖模块 ---- 完成
index.html 模块进入 afterLoad 回调, 剩余注册ID:  [ 'vite/modulepreload-polyfill' ]
modulepreload-polyfill  模块 loadPromise 解析完成, 剩余注册ID:  []
modulepreload-polyfill 模块进入 afterLoad 回调, 剩余注册ID:  []
----- debouncedProcessing -----
距入口模块加载完成的时间: 201.743ms

～～～～～～～～～～～～开启预构建流程～～～～～～～～～～～～
预构建扁平化ID 和 模块绝对路径的映射关系:  {
  'react_jsx-runtime': '/Users/Project/vite/packages/vite/demo/node_modules/react/jsx-runtime.js',
  'react_jsx-dev-runtime': '/Users/Project/vite/packages/vite/demo/node_modules/react/jsx-dev-runtime.js'
}

index.js 模块源码加载 --- 结束: 393.874ms
index.js 模块 transfrom 处理阶段 ---- 开始
----- debouncedProcessing -----
transforming (3) src/index.js
index.js 模块 transfrom 处理阶段 ---- 结束
index.js 模块获取所有子依赖模块 ---- 开始
index.js 模块 loadPromise 解析完成, 剩余注册ID:  []
react.js 模块开始获取信息

～～～～～～～～～～～～开启预构建流程～～～～～～～～～～～～
预构建扁平化ID 和 模块绝对路径的映射关系:  {
  'react_jsx-runtime': '/Users/Project/vite/packages/vite/demo/node_modules/react/jsx-runtime.js',
  'react_jsx-dev-runtime': '/Users/Project/vite/packages/vite/demo/node_modules/react/jsx-dev-runtime.js',
  react: '/Users/Project/vite/packages/vite/demo/node_modules/react/index.js'
}

index.js 模块进入 afterLoad 回调, 剩余注册ID:  []
7:40:27 PM [vite] ✨ new dependencies optimized: react
7:40:27 PM [vite] ✨ optimized dependencies changed. reloading
react.js 模块源码加载 --- 结束: 136.372ms
react.js 模块 transfrom 处理阶段 ---- 开始
transforming (4) node_modules/.vite/deps_build-dist/react.js
react.js 模块 transfrom 处理阶段 ---- 结束
react.js 模块获取所有子依赖模块 ---- 开始
chunk-BC7EONZ4.js?v=d4c32311 模块开始获取信息
chunk-BC7EONZ4.js?v=d4c32311 模块源码加载 --- 结束: 0.597ms
chunk-BC7EONZ4.js?v=d4c32311 模块 transfrom 处理阶段 ---- 开始
chunk-BC7EONZ4.js?v=d4c32311 模块 transfrom 处理阶段 ---- 结束
chunk-BC7EONZ4.js?v=d4c32311 模块获取所有子依赖模块 ---- 开始
chunk-BC7EONZ4.js?v=d4c32311 模块获取所有子依赖模块 ---- 完成
react.js 模块获取所有子依赖模块 ---- 完成
index.js 模块获取所有子依赖模块 ---- 完成
index.html 模块获取所有子依赖模块 ---- 完成
✓ 5 modules transformed.
```

可以看出来但子依赖模块过于庞大的话，加载时间过于长，那么就会存在重复执行预构建流程，而且构建过程并非增量构建而是重新构建。那么可能就有同学要问，如果频繁出现重新构建流程不就使得整体性能下降吗。那么我们就来分析一下出现这种情况的可能性吧，最简单复现的流程应该就是如上了，当然若同学直接使用上述场景(读取 `335.7 MB` 大小的模块)，通常会发现 JS 堆溢出了。经过分析可以得知在 `setSource` 里面有如下这么一段代码:

```js
this.ast = new Program(ast, { context: this.astContext, type: 'Module' }, this.scope);
```

这是 `ast` 构建的过程，`rollup` 在内部写了大量 `ast node constructor`。

```js
const nodeConstructors = {
  ArrayExpression,
  ArrayPattern,
  ArrowFunctionExpression,
  AssignmentExpression,
  AssignmentPattern,
  AwaitExpression,
  BinaryExpression,
  BlockStatement,
  BreakStatement,
  CallExpression,
  CatchClause,
  ChainExpression,
  ClassBody,
  ClassDeclaration,
  ClassExpression,
  ConditionalExpression,
  ContinueStatement,
  DoWhileStatement,
  EmptyStatement,
  ExportAllDeclaration,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  ExportSpecifier,
  ExpressionStatement,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  IfStatement,
  ImportDeclaration,
  ImportDefaultSpecifier,
  ImportExpression,
  ImportNamespaceSpecifier,
  ImportSpecifier,
  LabeledStatement,
  Literal,
  LogicalExpression,
  MemberExpression,
  MetaProperty,
  MethodDefinition,
  NewExpression,
  ObjectExpression,
  ObjectPattern,
  PrivateIdentifier,
  Program,
  Property,
  PropertyDefinition,
  RestElement,
  ReturnStatement,
  SequenceExpression,
  SpreadElement,
  StaticBlock,
  Super,
  SwitchCase,
  SwitchStatement,
  TaggedTemplateExpression,
  TemplateElement,
  TemplateLiteral,
  ThisExpression,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UnknownNode,
  UpdateExpression,
  VariableDeclaration,
  VariableDeclarator,
  WhileStatement,
  YieldExpression
};
```

因此 **`rollup`** 在解析大模块代码的时候会根据 **`代码ast结构`** 实例化 **`node constructor`**。那么对于 `335.7 MB` 的大型模块代码量大约在 **`1350w`** 行代码量，估计得有 **`675w`** 的实例化。对于 `V8 JS Runtime` 来说，提供老生代的空间大小约 `1.4G`, 也就是说均摊在每一个实例上为 `222B` 的大小，因此肯定是会溢出。

::: tip
这是我对延迟预构建流程写了简单的 **`demo`** 来助于理解整个流程
[pre-fetch-line](https://github.com/XiSenao/vite-design.github.io/blob/master/docs/demo/pre-fetch-line.js) 。
:::

### 开发环境
