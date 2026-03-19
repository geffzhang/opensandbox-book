import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenSandbox 源码解析',
  description: '阿里巴巴开源的 AI 应用通用沙盒平台——多语言 SDK 与 Docker/Kubernetes 运行时深度剖析',
  lang: 'zh-CN',
  cleanUrls: true,

  head: [
    ['link', { rel: 'icon', href: '/logo.png' }],
  ],

  themeConfig: {
    logo: '/logo.png',

    nav: [
      { text: '首页', link: '/' },
      { text: '开始阅读', link: '/chapters/01-overview' },
      { text: 'GitHub', link: 'https://github.com/alibaba/OpenSandbox' },
    ],

    sidebar: [
      {
        text: '基础篇',
        items: [
          { text: '第1章 项目概览', link: '/chapters/01-overview' },
          { text: '第2章 Repo 结构与平台架构', link: '/chapters/02-architecture' },
          { text: '第3章 统一沙盒 API 设计', link: '/chapters/03-api-design' },
        ],
      },
      {
        text: '运行时篇',
        items: [
          { text: '第4章 Docker 运行时后端', link: '/chapters/04-docker-runtime' },
          { text: '第5章 Kubernetes 运行时后端', link: '/chapters/05-kubernetes-runtime' },
        ],
      },
      {
        text: 'SDK 篇',
        items: [
          { text: '第6章 Python SDK 设计', link: '/chapters/06-python-sdk' },
          { text: '第7章 JavaScript SDK 设计', link: '/chapters/07-javascript-sdk' },
        ],
      },
      {
        text: '核心能力篇',
        items: [
          { text: '第8章 沙箱生命周期管理', link: '/chapters/08-lifecycle' },
          { text: '第9章 代码执行引擎', link: '/chapters/09-code-execution' },
          { text: '第10章 文件系统操作', link: '/chapters/10-filesystem' },
          { text: '第11章 进程管理与输出流', link: '/chapters/11-process-management' },
        ],
      },
      {
        text: '安全与隔离篇',
        items: [
          { text: '第12章 网络隔离策略', link: '/chapters/12-network-isolation' },
          { text: '第13章 资源限制与配额', link: '/chapters/13-resource-limits' },
          { text: '第18章 多租户与安全隔离', link: '/chapters/18-multi-tenancy' },
        ],
      },
      {
        text: 'AI 场景篇',
        items: [
          { text: '第14章 Coding Agent 场景优化', link: '/chapters/14-coding-agent' },
          { text: '第15章 GUI Agent 支持', link: '/chapters/15-gui-agent' },
          { text: '第16章 Agent 评估框架集成', link: '/chapters/16-evaluation' },
          { text: '第17章 RL 训练环境支持', link: '/chapters/17-rl-training' },
        ],
      },
      {
        text: '运维篇',
        items: [
          { text: '第19章 可观测性', link: '/chapters/19-observability' },
          { text: '第20章 生产部署最佳实践', link: '/chapters/20-deployment' },
        ],
      },
      {
        text: '附录',
        items: [
          { text: '附录A 推荐阅读路径', link: '/chapters/appendix-a-reading-paths' },
          { text: '附录B API 速查手册', link: '/chapters/appendix-b-api-reference' },
          { text: '附录C 名词解释', link: '/chapters/appendix-c-glossary' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/alibaba/OpenSandbox' },
    ],

    outline: {
      level: [2, 3],
      label: '本页目录',
    },

    docFooter: {
      prev: '上一章',
      next: '下一章',
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            noResultsText: '未找到结果',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    footer: {
      message: '基于 Apache 2.0 许可发布',
      copyright: 'Copyright © 2024-present Alibaba Group',
    },
  },
})
