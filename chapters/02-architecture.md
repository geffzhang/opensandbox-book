# 第2章 Repo 结构与平台架构

> "The structure of a codebase is the first design document — before reading any code, the directory tree tells you what the authors valued." — 改编自 John Ousterhout

## 顶层目录结构

打开 OpenSandbox 的仓库，你会看到一个清晰的顶层目录布局：

```
OpenSandbox/
├── .github/          # CI/CD 工作流
├── cli/              # 命令行工具
├── components/       # 核心组件（Go 语言）
│   ├── execd/        # 沙盒内执行守护进程
│   ├── ingress/      # 入口流量代理
│   ├── egress/       # 出口流量控制
│   └── internal/     # 共享内部库
├── docs/             # 架构与设计文档
├── examples/         # 21 个集成示例
├── kubernetes/       # K8s Operator + CRD + Helm Chart
├── oseps/            # 10 个增强提案（Enhancement Proposals）
├── sandboxes/        # 沙盒镜像定义（code-interpreter）
├── scripts/          # 开发与运维脚本
├── sdks/             # 多语言 SDK
├── server/           # Python FastAPI 生命周期服务器
├── specs/            # 3 份 OpenAPI 规范文件
└── tests/            # 跨组件集成测试
```

这个结构揭示了团队的几个关键设计决策。首先，**协议与实现分离** — `specs/` 目录独立于任何实现代码存在，三份 OpenAPI 文件（`sandbox-lifecycle.yml`、`execd-api.yaml`、`egress-api.yaml`）是整个系统的契约来源。其次，**多语言共存** — `components/` 使用 Go 编写高性能守护进程，`server/` 使用 Python FastAPI 实现业务逻辑，`sdks/` 则包含 Python、JavaScript、Kotlin、C# 四种语言的客户端库。

## SDK 的三层结构

`sdks/` 目录的组织方式值得关注：

```
sdks/
├── sandbox/              # 基础沙盒 SDK
│   ├── python/
│   ├── javascript/
│   ├── kotlin/
│   └── csharp/
├── code-interpreter/     # 代码解释器高级 SDK
│   ├── python/
│   ├── javascript/
│   ├── kotlin/
│   └── csharp/
└── mcp/                  # MCP 协议集成 SDK
    ├── python/
    └── javascript/
```

为什么要分三层？这是因为不同用户有不同的抽象需求。基础 SDK（`sandbox/`）提供沙盒生命周期和原始执行 API 的封装，适合需要完全控制的场景。code-interpreter SDK 在此基础上封装了代码上下文管理和执行结果解析，适合 AI 代码执行场景。MCP SDK 则直接暴露 Model Context Protocol 接口，让沙盒能作为 AI 工具被大语言模型直接调用。

## Server 内部结构

`server/` 是整个系统的核心，采用典型的分层架构：

```
server/src/
├── api/
│   ├── lifecycle.py      # 10 个路由定义
│   └── schema.py         # Pydantic 数据模型
├── middleware/
│   ├── auth.py           # API Key 认证中间件
│   └── request_id.py     # 请求追踪中间件
└── services/
    ├── factory.py         # 运行时工厂
    ├── sandbox_service.py # 抽象基类
    ├── docker.py          # Docker 后端（约 2132 行）
    └── k8s/               # Kubernetes 后端（15 个文件）
        ├── client.py
        ├── informer.py
        ├── kubernetes_service.py
        ├── batchsandbox_provider.py
        ├── agent_sandbox_provider.py
        ├── workload_provider.py
        ├── provider_factory.py
        ├── rate_limiter.py
        ├── volume_helper.py
        ├── egress_helper.py
        ├── image_pull_secret_helper.py
        ├── template_manager.py
        └── ...
```

这里有一个有趣的不对称：Docker 后端是单文件实现（`docker.py` 约 2132 行），而 Kubernetes 后端拆分为 15 个文件。这并非偶然。Docker API 相对简单，一个类就能封装完整的生命周期；而 Kubernetes 涉及 CRD 管理、Informer 缓存、速率限制、多种 Workload 类型等复杂抽象，自然需要更细粒度的模块划分。

Kubernetes 后端中每个文件都有明确的职责：`client.py` 封装 API 访问和缓存策略，`informer.py` 实现 List-Watch 模式，`rate_limiter.py` 提供令牌桶限流，`volume_helper.py` 和 `egress_helper.py` 分别处理存储和网络配置，`template_manager.py` 管理 Pod 模板渲染。这种按关注点分离的方式使得每个文件都可以独立理解和测试。

## 四层架构

从请求的流转角度看，OpenSandbox 是一个清晰的四层架构：

```
SDK 层          →  Lifecycle Server 层  →  运行时后端层       →  容器层
(Python/JS/     (FastAPI, lifecycle.py)  (Docker/K8s Service)  (execd 守护进程)
 Kotlin/C#)
```

**SDK 层** 负责将用户的高级操作（如"执行 Python 代码"）转换为 HTTP 请求。请求首先到达 **Lifecycle Server 层**，`api/lifecycle.py` 中的 10 个路由处理生命周期操作，通过 `middleware/auth.py` 完成 API Key 认证。路由层是纯粹的 HTTP 适配器，不包含业务逻辑。

真正的业务逻辑在 **运行时后端层**。`services/factory.py` 中的 `create_sandbox_service()` 工厂函数根据配置选择 Docker 或 Kubernetes 实现。两者都实现了 `SandboxService` 抽象基类（定义在 `services/sandbox_service.py`），保证了统一的接口契约。

**容器层** 是 execd 守护进程运行的地方。无论底层是 Docker 容器还是 Kubernetes Pod，execd 都提供相同的执行 API — 代码运行、命令执行、文件操作和系统监控。

## 工厂模式与运行时选择

`factory.py` 的实现遵循经典的工厂模式：维护一个字典映射运行时类型字符串（`"docker"` 或 `"kubernetes"`）到对应的 Service 类，根据配置实例化。如果传入不支持的类型，则抛出 `ValueError` 并列出所有可用选项。

这个设计使得未来添加新的运行时后端（例如 Firecracker 直接集成）只需要实现 `SandboxService` 接口并在工厂中注册即可，无需修改任何上层代码。

值得一提的是，工厂函数还接受一个可选的 override 参数，允许在运行时动态切换后端类型。这为测试场景提供了便利 — 集成测试可以在同一进程中切换 Docker 和 Kubernetes 后端，验证两者的行为一致性。

## Kubernetes 后端的 WorkloadProvider 抽象

Kubernetes 后端进一步引入了 `WorkloadProvider` 抽象层（`k8s/workload_provider.py`）。这是因为 Kubernetes 中"沙盒"可以映射到不同的资源类型 — `BatchSandbox` CRD（通过 `batchsandbox_provider.py`）用于批量沙盒管理，`AgentSandbox`（通过 `agent_sandbox_provider.py`）支持 `kubernetes-sigs/agent-sandbox` 社区标准。

`provider_factory.py` 负责根据配置选择具体的 Provider 实现。这种双层工厂模式（Service 工厂 + Provider 工厂）看似复杂，但实际上反映了 Kubernetes 生态的现实：社区有多种沙盒编排方案，OpenSandbox 需要灵活适配。

## components：Go 语言的高性能组件

`components/` 目录使用 Go 语言实现了四个核心组件，它们运行在容器内部或作为 sidecar 部署。为什么选择 Go 而非 Python？因为这些组件对性能和资源占用有严格要求 — execd 守护进程需要常驻容器内存，Go 的静态编译产物不依赖运行时环境，单个二进制文件即可注入任意容器。

- `execd/` — 沙盒内执行守护进程，暴露代码执行、命令运行和文件操作 API，监听端口 44772
- `ingress/` — 入口流量代理，为每个沙盒提供可寻址的外部端点
- `egress/` — 出口流量控制代理，基于 FQDN 白名单过滤出站请求
- `internal/` — 共享内部库，被其他三个组件引用

## OSEP 增强提案

`oseps/` 目录包含 10 个 OpenSandbox Enhancement Proposals，这是项目治理的重要组成部分。从 OSEP-0001（FQDN 出口控制，已实现）到 OSEP-0010（OpenTelemetry 可观测性集成），这些提案记录了每个重大功能的动机、设计方案和实施状态。

部分值得关注的提案包括：OSEP-0002 引入了对 `kubernetes-sigs/agent-sandbox` 社区标准的支持，OSEP-0004 实现了可插拔的安全容器运行时，OSEP-0005 设计了客户端连接池以降低沙盒创建延迟，OSEP-0008 则规划了基于 rootfs 快照的暂停/恢复机制（目前仍处于草案阶段）。这种透明的决策过程对于开源项目尤为重要。

## 本章小结

OpenSandbox 的仓库结构体现了协议与实现分离、多语言共存和分层架构三大原则。核心请求路径经过四层：SDK → Lifecycle Server（FastAPI）→ 运行时后端（Docker/K8s）→ 容器（execd）。工厂模式和 WorkloadProvider 抽象使得系统能够灵活适配不同的运行时和编排方案。在下一章中，我们将深入探讨驱动这一切的统一 API 设计。
