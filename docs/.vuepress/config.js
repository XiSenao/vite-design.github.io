const { description } = require('../../package')

module.exports = {
  /**
   * Ref：https://v1.vuepress.vuejs.org/config/#title
   */
  title: 'Vite Design',
  /**
   * Ref：https://v1.vuepress.vuejs.org/config/#description
   */
  description: description,

  /**
   * Extra tags to be injected to the page HTML `<head>`
   *
   * ref：https://v1.vuepress.vuejs.org/config/#head
   */
  head: [
    ['meta', { name: 'keywords', itemprop: 'keywords', content: 'vite 源码分析, rollup 打包流程' }],
    ['meta', { property: 'og:title', content: 'vite 源码分析' }],
    ['meta', { property: 'og:description', content: 'vite vue 源码分析 一个基于 Vue3 单文件组件的非打包开发服务器' }],
  ],

  /**
   * Theme configuration, here is the default theme configuration for VuePress.
   *
   * ref：https://v1.vuepress.vuejs.org/theme/default-theme-config.html
   */
  themeConfig: {
    repo: '',
    editLinks: false,
    docsDir: '',
    editLinkText: '',
    lastUpdated: false,
    nav: [
      {
        text: 'Guide',
        link: '/guide/',
      },
      {
        text: 'Github',
        link: 'https://github.com/FinalAshen/vite-design.github.io',
      },
    ],
    sidebar: {
      '/guide/': [
        {
          collapsable: true,
          children: [
            '',
            'chinese-doc',
            'getting-start',
            'config-resolve',
            'module-resolve',
            'sort-modules',
            'optimize',
            'render',
            'hmr',
            '2.0/optimize',
            '2.0/ssr',
            'plugins',
            'extension.md',
            'practicalities',
            'knowledge-expansion',
            'leedcode',
            'diary'
          ],
        }
      ]
    }
  },

  /**
   * Apply plugins，ref：https://v1.vuepress.vuejs.org/zh/plugin/
   */
  plugins: [
    '@vuepress/plugin-back-to-top',
    '@vuepress/plugin-medium-zoom',
  ]
}
