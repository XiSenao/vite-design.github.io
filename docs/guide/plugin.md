---
sidebarDepth: 3
---


# 插件

## [vite-plugin-inspect](https://github.com/antfu/vite-plugin-inspect)

### 用途

检查Vite插件的中间状态。用于调试和编写插件。

### 实现思路

1. **插件开启的逻辑**

    默认在开发模式下开启，若需要在生产环境开启可以通过配置

    ```js
    import Inspect from 'vite-plugin-inspect'

    export default defineConfig({
      plugins: [Inspect({
        // 需要满足 vite-plugin-inspect@v0.7.0 版本以上，而支持的 `vite` 则为 v3.1 或以上。 
        build: true
      })]
    })
    ```

2. **为插件提供检测能力**

    在 `configResolved` 阶段为每一个插件的 `transform`、`load`、`resolveId` 三个阶段的 hook 外部封装一层 `wrapper`，`wrapper` 的作用为判断是否需要收集插件的信息，例如在 `transform` 钩子里面若插件有返回值且`id` 无需过滤(归属于 `option.exclude` 的模块路径需要过滤掉)则收集模块信息，包含：`name: 模块名称`、`result: 转换后的代码`、`start: 执行当前plugin开始的时间`、`end: 执行完成当前plugin所耗费的时间`、`order: 插件的优先级`(对于 `rollup` 和 `transformIndexHTML` 的插件来说存在优先级)。这里存储的 `map` 有对是否为 `ssr` 做区分。

3. **开发服务配置**

4. **加载模块**

5. **热更新处理**

6. **构建完成**
