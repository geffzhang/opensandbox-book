# 第3章 统一沙盒 API 设计

> "A good API is not just an interface — it is a contract that shapes how every component in the system communicates." — Joshua Bloch

## Protocol-First：从规范到实现

在第1章中我们提到，OpenSandbox 的核心设计哲学是 Protocol-First。这意味着 API 规范不是从代码中生成的，而是反过来 — 代码是从规范中派生的。`specs/` 目录下的三份 OpenAPI 文件是整个系统的 **single source of truth**。

为什么选择这种方式？因为 OpenSandbox 面对的是一个天然的多语言、多组件系统。4 种语言的 SDK、Python 编写的 Lifecycle Server、Go 编写的 execd 守护进程和 egress 代理 — 如果每个组件各自定义接口，版本漂移几乎不可避免。统一的 OpenAPI 规范消除了这种风险。

## 三份规范，三个关注点

```
specs/
├── sandbox-lifecycle.yml    # 沙盒生命周期管理
├── execd-api.yaml           # 容器内代码与命令执行
└── egress-api.yaml          # 出口网络策略控制
```

这三份规范对应三个不同的网络边界和运行主体：

**sandbox-lifecycle.yml** 定义了 Lifecycle Server 暴露给 SDK 的 API。这是外部客户端唯一直接交互的接口，负责沙盒的创建、查询、删除、暂停、恢复和续期。

**execd-api.yaml** 定义了 execd 守护进程在容器内部暴露的 API。SDK 通常不直接调用这些端点，而是通过 Lifecycle Server 的 proxy 路由（`/sandboxes/{id}/proxy/{port}/...`）透传。

**egress-api.yaml** 定义了 egress sidecar 的策略管理接口。这是一个仅内部使用的 API，运行在 `localhost:18080`，用于运行时动态调整出口网络规则。

## 生命周期 API 的 10 个路由

`server/src/api/lifecycle.py` 实现了 10 个路由，全部注册在 `/` 和 `/v1` 两个前缀下：

| 方法 | 路径 | 用途 | 状态码 |
|------|------|------|--------|
| POST | `/sandboxes` | 创建沙盒 | 202 |
| GET | `/sandboxes` | 列出沙盒（支持分页和过滤） | 200 |
| GET | `/sandboxes/{id}` | 获取沙盒详情 | 200 |
| DELETE | `/sandboxes/{id}` | 删除沙盒 | 204 |
| POST | `/sandboxes/{id}/pause` | 暂停沙盒 | 202 |
| POST | `/sandboxes/{id}/resume` | 恢复沙盒 | 202 |
| POST | `/sandboxes/{id}/renew-expiration` | 续期 | 200 |
| GET | `/sandboxes/{id}/endpoints/{port}` | 获取访问端点 | 200 |
| * | `/sandboxes/{id}/proxy/{port}/{path}` | 代理请求 | 透传 |

一个值得注意的设计选择是 **异步创建语义**。CREATE、PAUSE、RESUME 三个操作都返回 HTTP 202 Accepted 而非 200 OK，表示操作已接受但尚未完成。客户端需要轮询 GET 接口获取最终状态。这个决策源于实际的延迟特性 — 创建一个沙盒可能需要拉取镜像、分配资源、等待 Pod 就绪，这些操作可能耗时数十秒，同步等待会阻塞客户端。

沙盒状态机涵盖 7 个状态：`Pending`、`Running`、`Pausing`、`Paused`、`Stopping`、`Terminated`、`Failed`。其中 `Pausing` 和 `Stopping` 是过渡态，反映了异步操作的中间过程。

## execd 执行 API：三大能力域

execd 守护进程暴露的 API 按功能域划分为三大类：

### 代码执行

- `POST /code/context` — 创建执行上下文
- `POST /code` — 执行代码（支持 SSE 流式输出）
- `DELETE /code` — 中断正在执行的代码
- `GET /code/contexts` — 列出活跃上下文
- `DELETE /code/contexts` — 清除指定语言的所有上下文

代码执行基于 Jupyter 内核协议，这意味着每个"上下文"本质上是一个持久化的内核会话，变量和状态在多次执行间保持。这对 AI 代码执行场景至关重要 — Agent 通常需要在多轮对话中逐步构建和调试代码。

### 命令执行

- `POST /command` — 执行 shell 命令（前台/后台模式）
- `DELETE /command` — 中断命令
- `GET /command/status/{id}` — 查询命令状态
- `GET /command/{id}/logs` — 获取后台命令输出（基于游标分页）

命令执行区分前台和后台模式，后台命令通过游标分页获取日志，这避免了长时间运行命令的超时问题。前台命令同步返回输出和退出码，适合快速的一次性操作；后台命令立即返回命令 ID，客户端通过 `GET /command/status/{id}` 轮询状态，再用 `GET /command/{id}/logs` 获取输出。这种双模式设计贴合了 AI Agent 的实际使用模式 — 短命令（如 `ls`、`pip install`）用前台模式获得即时反馈，长命令（如模型训练、数据处理）用后台模式避免连接超时。

### 文件操作

- `GET /files/info`、`DELETE /files`、`POST /files/permissions`
- `POST /files/mv`、`GET /files/search`、`POST /files/replace`
- `POST /files/upload`、`GET /files/download`
- `POST /directories`、`DELETE /directories`

文件操作 API 共 10 个端点，覆盖了元数据查询、CRUD、权限管理、搜索替换和批量上传下载。`GET /files/download` 支持 HTTP Range 请求，适合大文件的断点续传。

此外，`GET /metrics` 和 `GET /metrics/watch`（SSE）提供 CPU 和内存的实时监控能力。快照接口返回瞬时值，适合轮询场景；而 SSE 流式接口推送持续的指标更新，适合在前端仪表盘中展示实时资源消耗趋势。对于 RL 训练等批量场景，监控接口还可以帮助调度系统判断沙盒是否处于空闲状态，从而做出资源回收决策。

## 三层认证机制

OpenSandbox 在不同网络边界实施了不同的认证策略：

**第一层：API Key 认证**。SDK 访问 Lifecycle Server 时，必须在请求头中携带 `OPEN-SANDBOX-API-KEY`。`server/src/middleware/auth.py` 中的 `AuthMiddleware` 负责验证。部分路径被豁免认证，包括 `/health`、`/docs`、`/redoc` 和 proxy 路由（proxy 路由依赖 execd 自身的认证）。

**第二层：execd Token**。容器内的 execd 守护进程使用 `X-EXECD-ACCESS-TOKEN` 头进行认证，防止同一网络中的其他容器未授权访问执行 API。

**第三层：egress Token**。egress sidecar 使用 `OPENSANDBOX-EGRESS-AUTH` 头保护策略管理接口，确保只有 Lifecycle Server 能修改出口规则。

这种分层设计体现了最小权限原则 — 每一层只暴露必要的认证信息，避免单一 token 泄漏导致全面失控。

## 错误规范化

一个成熟的 API 需要结构化的错误处理。OpenSandbox 定义了分层的错误码体系：Docker 后端 18 个错误码、Kubernetes 后端 6 个、通用错误 4 个、卷操作错误 22 个。所有错误响应都遵循统一的 `ErrorResponse` schema，包含错误码、人类可读消息和可选的详情字段。

这种设计使得 SDK 层可以对不同运行时后端的错误进行统一处理，而不需要了解底层实现细节。例如，无论 Docker 返回 `CONTAINER_NOT_FOUND` 还是 Kubernetes 返回 `POD_NOT_FOUND`，SDK 都能映射为语义一致的"沙盒不存在"错误。

## 双前缀注册

路由同时注册在 `/` 和 `/v1` 前缀下，这是一个面向未来的兼容性设计。当前版本的 API 在两个前缀下行为完全一致。未来如果引入破坏性变更，可以在 `/v2` 前缀下注册新版本，同时保持 `/v1` 的向后兼容。无版本前缀的 `/` 始终指向最新版本，方便快速上手。

## 本章小结

OpenSandbox 的 API 设计以三份 OpenAPI 规范为核心，覆盖了沙盒生命周期、容器内执行和出口策略三个关注点。异步创建语义、基于 Jupyter 内核的代码执行、三层认证机制和分层错误码体系，这些设计选择都源于 AI 应用沙盒的实际需求。统一的协议契约使得 4 种语言的 SDK 和 2 种运行时后端能够保持一致的行为语义。
