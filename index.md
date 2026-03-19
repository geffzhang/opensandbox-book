---
layout: home

hero:
  name: OpenSandbox
  text: 源码解析
  tagline: 阿里巴巴开源的 AI 应用通用沙盒平台——多语言 SDK 与 Docker/Kubernetes 运行时深度剖析
  image:
    src: /logo.png
    alt: OpenSandbox
  actions:
    - theme: brand
      text: 开始阅读
      link: /chapters/01-overview
    - theme: alt
      text: GitHub 仓库
      link: https://github.com/alibaba/OpenSandbox

features:
  - icon:
      src: /icons/sandbox.svg
    title: 通用沙盒
    details: Protocol-First 设计，OpenAPI 3.1 规范驱动，统一的沙盒生命周期管理接口，支持任意容器镜像
  - icon:
      src: /icons/runtime.svg
    title: 多运行时
    details: Docker 与 Kubernetes 双运行时后端，WorkloadProvider 抽象层，支持 gVisor / Kata / Firecracker 安全运行时
  - icon:
      src: /icons/ai.svg
    title: AI 场景
    details: Coding Agent、GUI Agent、RL 训练、评估框架全面支持，集成 Claude Code / Gemini / Codex 等主流 AI Agent
  - icon:
      src: /icons/production.svg
    title: 生产就绪
    details: 三层网络隔离、多租户安全、资源配额、可观测性，BatchSandbox 批量调度与 Pool 预热池
---

## 关于本书

本书是对 [OpenSandbox](https://github.com/alibaba/OpenSandbox) 项目的深度源码解析，涵盖 20 个章节与 3 个附录，从架构设计到生产部署，全面剖析这一 AI 应用通用沙盒平台的实现细节。

### 读者对象

- 希望在 AI 应用中集成安全沙盒环境的**后端工程师**
- 正在构建 AI Agent 基础设施的**平台工程师**
- 对容器编排与安全隔离感兴趣的**云原生开发者**
- 希望深入理解开源项目设计决策的**技术爱好者**

### 如何阅读

你可以从 [第 1 章：项目概览](/chapters/01-overview) 开始顺序阅读，也可以参考 [附录 A：推荐阅读路径](/chapters/appendix-a-reading-paths) 根据你的角色选择最合适的阅读顺序。
