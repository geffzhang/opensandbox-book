# 第7章 JavaScript SDK 设计

> "任何可以用 JavaScript 编写的应用程序，最终都会用 JavaScript 编写。" —— Jeff Atwood

## 7.1 技术栈与工程架构

JavaScript SDK 位于 `sdks/sandbox/javascript/src/`，采用 TypeScript 编写，构建工具链包括 tsup（基于 esbuild 的快速打包器）、pnpm workspace 管理 monorepo 依赖、ESLint 进行代码质量控制。选择 TypeScript 而非纯 JavaScript 的原因显而易见：沙箱 API 涉及大量结构化参数（镜像配置、网络策略、资源限制等），类型系统能在编译期捕获配置错误，极大降低运行时故障概率。

包结构与 Python SDK 呈现高度对称：

```
src/
├── adapters/      # HTTP 适配层
├── api/           # 底层 API 调用
├── config/        # 连接配置
├── core/          # 核心基础设施
├── factory/       # 工厂模式实现
├── models/        # TypeScript 类型与接口定义
├── openapi/       # OpenAPI 规范生成的客户端
├── services/      # 高层服务封装
├── index.ts       # 公共导出入口
├── internal.ts    # 内部导出（不对外暴露）
├── manager.ts     # SandboxManager 管理器
└── sandbox.ts     # Sandbox 核心类
```

一个值得关注的差异是 `factory/` 和 `core/` 目录的存在。`factory/` 目录封装了适配器的创建逻辑，而 `core/` 提供了 JavaScript 生态特有的基础设施——例如环境检测（Node.js vs 浏览器）、Promise 工具函数等。此外，`openapi/` 目录表明 JS SDK 采用了 OpenAPI 代码生成策略，从 `specs/` 中的 OpenAPI 规范自动生成底层 HTTP 客户端代码，减少手写样板代码的维护负担。

## 7.2 Sandbox 类：镜像 Python API

Sandbox 类的公共 API 与 Python 版本保持了惊人的一致性：

**静态工厂方法：**
- `Sandbox.create(options)` — 创建新沙箱
- `Sandbox.connect(options)` — 连接已有沙箱
- `Sandbox.resume(options)` — 恢复暂停的沙箱

**生命周期管理：**
- `pause()` / `kill()` / `close()` — 暂停、终止、释放资源
- `renew(timeout)` — 延长过期时间

**状态监控：**
- `getInfo()` — 获取沙箱状态信息
- `isHealthy()` — 健康检查
- `getMetrics()` — 资源用量指标
- `waitUntilReady(options)` — 轮询等待就绪，支持自定义超时和健康检查回调

这种跨语言的 API 一致性并非偶然，而是项目的核心设计原则。`sandbox.ts` 中的 `SandboxCreateOptions` 接口定义了完整的创建参数，包括 `image`（镜像 URI）、`envs`（环境变量）、`networkPolicy`（网络策略）、`volumes`（存储卷配置）、`resources`（资源限制）以及 `healthCheck`（健康检查配置）。每一个参数都能在 Python SDK 的 `Sandbox.create()` 中找到对应物。

## 7.3 网络与端点管理

JavaScript SDK 在网络操作上提供了比 Python 更丰富的便捷方法：

```typescript
getEndpoint(port)        // 获取指定端口的端点信息
getEndpointUrl(port)     // 直接获取可访问的 URL 字符串
getEgressPolicy()        // 查询出口流量策略
patchEgressRules(rules)  // 增量更新出口规则
```

`getEndpointUrl()` 是 JS SDK 独有的便捷方法，它在 `getEndpoint()` 基础上直接拼接出完整 URL，省去了用户手动组装协议、主机名和端口的步骤。这个小小的差异反映了 JavaScript 生态中"约定优于配置"的偏好——Web 开发者更习惯直接使用 URL 字符串而非结构化端点对象。

## 7.4 私有状态管理的巧思

实现层面有一个精巧的设计：Sandbox 类使用 **WeakMap** 存储内部配置（适配器工厂、基础 URL、Egress 服务实例等），而非使用 TypeScript 的 `private` 关键字。

为什么选择 WeakMap？原因有二：首先，WeakMap 提供了**真正的运行时私有性**，而 TypeScript 的 `private` 仅在编译期生效，运行时仍可被访问。对于 SDK 这种需要严格封装内部状态的场景，WeakMap 更加安全。其次，WeakMap 以对象实例为键，当 Sandbox 实例被垃圾回收时，关联的内部状态也会自动释放，避免内存泄漏。

这种模式在保持 Sandbox 类**公共接口简洁**的同时，将适配器创建逻辑、底层 HTTP 客户端等实现细节彻底隐藏，用户只能看到他们需要关心的方法和属性。

## 7.5 跨语言 API 一致性哲学

OpenSandbox 在 SDK 设计上追求的不仅是功能覆盖，更是**跨语言的体验一致性**。除了 Python 和 JavaScript，项目还提供了：

- **Kotlin SDK**（`sdks/sandbox/kotlin/`）— 面向 Java/Kotlin 生态，利用协程实现异步
- **C#/.NET SDK**（`sdks/sandbox/csharp/`）— 面向 .NET 生态，采用 async/await 模式

所有 SDK 遵循统一的设计约定：

1. **相同的工厂方法签名**：`create()` / `connect()` / `resume()` 在每种语言中语义一致
2. **相同的生命周期动词**：`pause` / `kill` / `close` / `renew` 跨语言统一
3. **相同的服务访问模式**：通过属性或方法获取 files、commands、metrics 服务
4. **相同的参数结构**：创建选项、网络策略、卷配置等数据模型跨语言对齐

为什么投入如此大的精力追求一致性？因为 OpenSandbox 的目标用户是 AI Agent 开发者——他们可能在 Python 中构建核心逻辑，在 TypeScript 中编写前端集成，在 Kotlin 中开发 Android 应用。跨语言的一致 API 意味着**学一次，处处用**，大幅降低多语言协作的认知负担。

这种一致性通过 `specs/` 目录下的 OpenAPI 规范保证：所有 SDK 的底层 API 调用都从同一份规范生成或对齐，确保参数命名、请求格式、响应结构在各语言间严格对应。

## 7.6 Code Interpreter JS SDK

`sdks/code-interpreter/javascript/` 提供了 JavaScript 版本的代码解释器 SDK，封装了多语言代码执行的高层接口。它建立在核心 Sandbox SDK 之上，通过 execd 暴露的 Jupyter 执行端点实现：

- 有状态的代码执行会话管理
- 流式输出（stdout/stderr）接收
- 执行结果（文本、图表、错误）的结构化解析

JS 版 Code Interpreter SDK 与 Python 版共享相同的后端能力（Jupyter kernel 执行引擎），但在接口设计上遵循 JavaScript 的异步惯例——基于 Promise 和 async/await 而非回调，结果通过事件或流式接口推送。

## 7.7 构建与发布

SDK 使用 tsup 进行构建，同时输出 ESM 和 CJS 格式以兼容不同的模块系统。pnpm workspace 将 sandbox SDK、code-interpreter SDK 以及共享工具库统一管理在 monorepo 中，确保内部依赖版本的一致性。`index.ts` 作为公共导出入口，精心控制了哪些类型和类对外可见，而 `internal.ts` 则为 monorepo 内部的其他包提供受限的内部接口访问。

这种 `index.ts` / `internal.ts` 的双入口设计是 TypeScript monorepo 的常见最佳实践：对外保持 API 表面最小化，对内允许必要的实现共享，在封装性和复用性之间取得平衡。

## 本章小结

JavaScript SDK 在忠实镜像 Python API 的基础上，融入了 TypeScript 生态的最佳实践：WeakMap 实现真正的私有状态、OpenAPI 代码生成减少样板代码、tsup + pnpm workspace 构成现代化工具链。四种语言 SDK（Python、JavaScript、Kotlin、C#）共同构成了一个**以 OpenAPI 规范为中心的多语言 SDK 矩阵**，让不同技术栈的开发者都能以最符合其语言习惯的方式使用 OpenSandbox 的全部能力。
