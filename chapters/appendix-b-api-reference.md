# 附录B API 速查手册

本附录汇总 OpenSandbox 全部 HTTP API，按功能域分组，供开发过程中快速查阅。每个接口列出 HTTP 方法、路径、典型状态码及简要说明。详细的请求与响应 schema 请参考项目仓库中的 OpenAPI 定义文件。

## 认证方式

OpenSandbox 的不同组件使用独立的认证 Header：

| Header | 适用组件 | 说明 |
|--------|---------|------|
| `OPEN-SANDBOX-API-KEY` | Server API | 管理面 API 密钥，用于沙箱生命周期操作 |
| `X-EXECD-ACCESS-TOKEN` | execd API | 执行面访问令牌，随沙箱创建时生成 |
| `OPENSANDBOX-EGRESS-AUTH` | Egress API | 出站策略管理令牌 |

## 生命周期 API（Server）

Server 负责沙箱实例的创建、查询、销毁和状态管理。

| 方法 | 路径 | 状态码 | 说明 |
|------|------|--------|------|
| `POST` | `/sandboxes` | 202 | 创建沙箱实例。返回 202 表示异步创建已接受，沙箱将在后台完成初始化 |
| `GET` | `/sandboxes` | 200 | 列出所有沙箱实例，支持分页与状态过滤 |
| `GET` | `/sandboxes/{id}` | 200 | 查询指定沙箱的详细信息，包括状态、端点和元数据 |
| `DELETE` | `/sandboxes/{id}` | 204 | 销毁指定沙箱，释放所有关联资源。返回 204 表示删除成功无内容返回 |
| `POST` | `/sandboxes/{id}/pause` | 202 | 暂停沙箱，冻结容器进程但保留资源。适用于需要临时释放计算资源的场景 |
| `POST` | `/sandboxes/{id}/resume` | 202 | 恢复已暂停的沙箱，进程从冻结点继续执行 |
| `POST` | `/sandboxes/{id}/renew-expiration` | 200 | 续期沙箱的过期时间，防止自动回收 |
| `GET` | `/sandboxes/{id}/endpoints/{port}` | 200 | 获取沙箱指定端口的外部访问端点信息 |
| `*` | `/sandboxes/{id}/proxy/{port}/{path}` | - | 代理请求到沙箱内部服务。支持所有 HTTP 方法，路径和查询参数透传 |

> **注意**：`POST /sandboxes` 和暂停 / 恢复接口返回 202 而非 200，表明这些操作是异步执行的。客户端应通过轮询 `GET /sandboxes/{id}` 或监听事件来确认操作完成。

## 执行 API（execd）

execd 是运行在沙箱容器内部的守护进程，提供代码执行和命令运行能力。

| 方法 | 路径 | 状态码 | 说明 |
|------|------|--------|------|
| `POST` | `/code/context` | 200 | 设置代码执行上下文，包括环境变量、工作目录等预配置 |
| `POST` | `/code` | 200 (SSE) | 提交代码执行请求，通过 SSE 流式返回执行输出。支持多语言，底层对接 Jupyter Kernel |
| `DELETE` | `/code` | 200 | 中断当前正在执行的代码，强制终止 Kernel 中运行的任务 |
| `POST` | `/command` | 200 | 执行 Shell 命令，支持设置超时和工作目录 |
| `GET` | `/command/status/{id}` | 200 | 查询异步命令的执行状态，返回运行中、完成或失败 |
| `GET` | `/command/{id}/logs` | 200 | 获取指定命令的 stdout 和 stderr 输出日志 |

> **SSE 说明**：`POST /code` 接口使用 Server-Sent Events 协议推送执行结果。客户端需要以 SSE 模式读取响应体，事件类型包括 `stdout`、`stderr`、`result` 和 `error`。

## 文件 API（execd）

文件操作接口同样由 execd 提供，覆盖沙箱内文件系统的完整 CRUD 操作。

| 方法 | 路径 | 状态码 | 说明 |
|------|------|--------|------|
| `GET` | `/files/info` | 200 | 查询文件或目录的元信息，包括大小、权限、修改时间 |
| `DELETE` | `/files` | 200 | 删除指定文件 |
| `POST` | `/files/permissions` | 200 | 修改文件权限，等效于 chmod 操作 |
| `POST` | `/files/mv` | 200 | 移动或重命名文件 |
| `GET` | `/files/search` | 200 | 在指定目录下搜索文件，支持名称模式匹配 |
| `POST` | `/files/replace` | 200 | 搜索并替换文件内容，支持正则表达式 |
| `POST` | `/files/upload` | 200 | 上传文件到沙箱内指定路径 |
| `GET` | `/files/download` | 200 | 下载沙箱内的文件。支持 HTTP Range Header 实现断点续传和分片下载 |
| `POST` | `/directories` | 200 | 创建目录，支持递归创建（等效于 mkdir -p） |
| `DELETE` | `/directories` | 200 | 删除目录及其内容 |

## Metrics API（execd）

用于监控沙箱内部的资源使用情况。

| 方法 | 路径 | 状态码 | 说明 |
|------|------|--------|------|
| `GET` | `/metrics` | 200 | 获取当前时刻的资源指标快照，包括 CPU、内存、磁盘使用率 |
| `GET` | `/metrics/watch` | 200 (SSE) | 以 SSE 方式持续推送资源指标变化，适合实时监控面板 |

## Egress API

管理沙箱的出站网络策略，控制沙箱内进程可以访问的外部地址。

| 方法 | 路径 | 状态码 | 说明 |
|------|------|--------|------|
| `GET` | `/policy` | 200 | 获取当前沙箱的出站策略配置，包括允许和拒绝的 FQDN 列表 |
| `PATCH` | `/policy` | 200 | 增量更新出站策略，可添加或移除允许访问的域名 |

## 健康检查端点

各组件均暴露健康检查端点，供 Kubernetes 探针和负载均衡器使用：

| 路径 | 用途 | 说明 |
|------|------|------|
| `/health` | 综合健康检查 | 返回组件的详细健康状态，包括依赖服务的连通性 |
| `/ping` | 存活探测 | 最轻量的存活检查，仅确认进程在运行 |
| `/status.ok` | 就绪探测 | 确认服务已完成初始化，可以接受流量 |
| `/healthz` | Kubernetes 探针 | 兼容 Kubernetes 标准的健康检查路径 |

## 状态码约定

OpenSandbox API 遵循以下状态码约定：

- **200**：请求成功，响应体包含结果数据
- **202**：异步操作已接受，操作将在后台完成
- **204**：操作成功，无响应体（常见于 DELETE）
- **400**：请求参数错误
- **401**：认证失败，缺少或无效的 API Key / Token
- **404**：目标资源不存在
- **409**：状态冲突，例如对已暂停的沙箱执行暂停操作
- **429**：请求频率超限
- **500**：服务端内部错误
