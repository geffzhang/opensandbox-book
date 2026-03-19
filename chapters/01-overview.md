# 第1章 项目概览：AI 应用沙盒的设计挑战

> "Any sufficiently advanced AI system eventually needs a sandbox — not to limit it, but to let it act safely in the real world."

## 为什么 AI 应用需要沙盒？

当我们让大语言模型执行代码、操作文件系统、甚至控制浏览器时，一个根本性问题浮出水面：**如何在赋予 AI 行动能力的同时，确保它不会破坏宿主环境？**

传统的容器技术虽然提供了进程级隔离，但 AI 应用场景对沙盒提出了更高要求。一个 Coding Agent 可能需要在几秒内启动一个完整的 Python 运行环境，执行用户提交的任意代码，再在任务结束后彻底销毁。一个 RL 训练框架可能需要同时运行数百个沙盒实例，每个实例都有独立的网络策略。一个 GUI Agent 则可能需要完整的桌面环境和浏览器自动化能力。

更具体地说，AI 沙盒需要解决传统容器不曾面对的问题：**亚秒级冷启动**（用户不能等待分钟级的容器拉起）、**多语言代码执行**（Python、JavaScript、TypeScript 乃至更多语言需要在同一个沙盒中运行）、**精确的资源回收**（临时沙盒如果不能及时销毁，集群资源会在数小时内耗尽）。

这些需求催生了 OpenSandbox — 阿里巴巴开源的 AI 应用沙盒平台。

## OpenSandbox 是什么

OpenSandbox 是一个为 AI 应用量身打造的沙盒运行平台，提供多语言 SDK、统一沙盒 API 和 Docker/Kubernetes 双运行时后端。项目于 2025 年开源，采用 Apache 2.0 许可证，代码托管在 `github.com/alibaba/OpenSandbox`。

它的核心使命可以用一句话概括：**让 AI 应用安全地与真实世界交互**。无论是代码执行、文件操作、命令运行还是网络访问，OpenSandbox 都在一个受控的沙盒环境中完成。

## 核心设计挑战

构建这样一个平台，团队面临了三大设计挑战：

### 挑战一：容器生命周期管理

AI 应用的沙盒与传统微服务容器有本质区别。沙盒是临时的、按需创建的，需要精确的生命周期控制 — 创建、暂停、恢复、续期、销毁。每个沙盒都有过期时间，需要自动清理机制防止资源泄漏。Docker 运行时通过线程安全的计时器字典实现了这一点（见 `server/src/services/docker.py` 的状态管理逻辑），而 Kubernetes 运行时则依赖 CRD 的 `ExpireTime` 字段。

### 挑战二：网络隔离与出口控制

沙盒中的代码可能试图访问内网敏感服务或发起恶意请求。OpenSandbox 采用 egress sidecar 模式解决这一问题：每个需要网络策略的沙盒都会附带一个出口代理容器（`components/egress/`），基于 FQDN 白名单控制出站流量。这个设计选择源于一个务实考量 — 在 Docker 环境中，iptables 规则难以在容器粒度上灵活管理，而 sidecar 模式天然支持按沙盒的策略隔离。

### 挑战三：多运行时与多语言支持

不同的部署场景需要不同的运行时：本地开发用 Docker，生产环境用 Kubernetes，高安全场景用 gVisor 或 Kata Containers。而不同的上层应用使用不同的编程语言。OpenSandbox 通过 **Protocol-First** 设计哲学统一解决了这两个维度的多样性。

## 设计哲学：Protocol-First

OpenSandbox 最重要的架构决策是 **协议优先**。项目在 `specs/` 目录下维护了三份 OpenAPI 3.1 规范文件：

- `sandbox-lifecycle.yml` — 沙盒生命周期 API
- `execd-api.yaml` — 容器内执行 API
- `egress-api.yaml` — 出口策略 API

所有 SDK（Python、JavaScript/TypeScript、Kotlin/Java、C#/.NET）和运行时后端都是这三份规范的实现。这意味着你可以用任何语言编写客户端，只要遵循相同的 API 契约。目前项目提供了 4 种语言的 SDK，覆盖了 sandbox 基础操作、code-interpreter 高级功能和 MCP（Model Context Protocol）集成三个层次。

### execd 注入模式

另一个精妙的设计是 **execd 注入模式**。OpenSandbox 不要求用户构建专门的沙盒镜像。相反，它在容器启动时通过内存缓存的 tar 归档将 execd 守护进程（`components/execd/`，用 Go 编写）注入到任意容器中，并用 bootstrap 脚本包装原始 entrypoint。这样，任何标准 Docker 镜像都可以变成一个功能完整的沙盒。

### Jupyter 内核协议

对于代码执行场景，execd 实现了 Jupyter 内核协议，这使得沙盒天然支持 Python、JavaScript、TypeScript 等多种语言的交互式代码执行，无需为每种语言编写专门的执行引擎。这个选择堪称点睛之笔 — Jupyter 生态已经为数十种编程语言实现了内核，OpenSandbox 站在这个巨人的肩膀上，以极低的开发成本获得了广泛的语言支持。同时，内核的有状态特性天然适配 AI Agent 的多轮对话场景：变量、函数定义和导入的模块在同一个会话中持续存在，Agent 可以像人类开发者一样逐步构建和迭代代码。

## 生态集成

OpenSandbox 的 `examples/` 目录包含 21 个集成示例，涵盖了当前 AI 生态的主要场景：Claude Code、Gemini CLI、Codex CLI、LangGraph、Google ADK 等 AI 工具链，以及 Playwright 浏览器自动化、VS Code 远程开发、RL 训练等专业场景。这种广泛的集成覆盖说明了 Protocol-First 设计的实际价值 — 统一的 API 让集成成本极低。

## 安全纵深

在安全层面，OpenSandbox 采用纵深防御策略，从内到外构建了四道防线：

**容器层面**：丢弃 9 项 Linux capabilities（如 `NET_RAW`、`SYS_ADMIN` 等），启用 `no_new_privileges` 阻断权限提升路径，支持 AppArmor 和 Seccomp 安全配置限制系统调用范围，设置 `pids_limit=512` 防止 fork bomb 攻击。

**运行时层面**：通过 `SecureRuntimeResolver` 支持 gVisor（用户态内核拦截系统调用）、Kata Containers（轻量虚拟机隔离）和 Firecracker microVM（亚秒级启动的微虚拟机）三种安全容器技术。

**网络层面**：egress sidecar 代理基于 FQDN 白名单控制出站流量，支持通配符域名匹配，运行时可通过 API 动态更新策略。

**API 层面**：三层认证机制 — Lifecycle Server 的 `OPEN-SANDBOX-API-KEY`、execd 的 `X-EXECD-ACCESS-TOKEN`、egress 的 `OPENSANDBOX-EGRESS-AUTH` — 在不同网络边界实施独立认证。这种多层防御确保了即使单一层面被突破，整体安全仍然有保障。

## 本章小结

OpenSandbox 是一个为 AI 应用设计的开源沙盒平台，通过 Protocol-First 的设计哲学、execd 注入模式和 Jupyter 内核协议，解决了容器生命周期管理、网络隔离和多运行时支持三大核心挑战。它支持 Docker 和 Kubernetes 双运行时后端，提供 4 种语言的 SDK，并与 21 个 AI 生态项目实现了集成。在接下来的章节中，我们将深入其代码结构和实现细节。
