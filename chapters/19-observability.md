# 第19章 可观测性（日志、指标）

> "You can observe a lot by watching." —— Yogi Berra

分布式系统的调试难度远高于单体应用。当一个 AI Agent 在沙箱中执行代码失败时，问题可能出在 Lifecycle API、execd 守护进程、容器运行时、网络策略等任何一个环节。OpenSandbox 通过请求追踪、结构化日志、资源监控和多层健康检查，构建了贯穿全链路的可观测性体系。

## 19.1 请求 ID 追踪

分布式追踪的第一步是为每个请求分配一个唯一标识符。`server/src/middleware/request_id.py` 实现了这一机制：

```python
request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)

class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        raw = request.headers.get(X_REQUEST_ID_HEADER)
        request_id = (raw and raw.strip()) or uuid.uuid4().hex
        token = request_id_ctx.set(request_id)
        try:
            response = await call_next(request)
            response.headers[X_REQUEST_ID_HEADER] = request_id
            return response
        finally:
            request_id_ctx.reset(token)
```

这段代码包含三个关键设计决策：

**Header 传播而非生成**：中间件优先读取请求中已有的 `X-Request-ID` header。如果上游服务（如 API 网关或 Agent 框架）已经生成了 request ID，OpenSandbox 会沿用它而非创建新的。这确保了跨服务的请求链路可以通过同一个 ID 串联起来。只有当请求中不包含此 header 时，才自动生成 `uuid.uuid4().hex`。

**ContextVar 异步安全**：Python 的 `contextvars.ContextVar` 是专为 asyncio 设计的上下文存储机制。在 FastAPI 的异步架构中，多个请求可能在同一个线程中并发执行。如果使用 threading.local，不同请求的 request ID 会互相覆盖。ContextVar 保证每个异步任务链（coroutine chain）拥有独立的上下文。

**finally 中的 reset**：`request_id_ctx.reset(token)` 确保即使请求处理过程中发生异常，context variable 也会被正确清理。这防止了请求 ID 泄漏到后续不相关的请求中——一个容易被忽视但后果严重的 bug。

## 19.2 日志注入与格式化

Request ID 的真正价值在于它能被自动注入到所有日志记录中。`RequestIdFilter` 类实现了这一功能：

```python
class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        rid = get_request_id()
        setattr(record, "request_id", rid if rid else "-")
        return True
```

这个 logging.Filter 被附加到所有日志 handler 上。它从 ContextVar 中读取当前 request ID，并注入到 log record 的 `request_id` 属性中。当没有请求上下文时（如服务启动阶段或定时任务），request_id 显示为 `"-"`。

`server/src/main.py` 中定义的日志格式为：

```
%(levelprefix)s %(asctime)s [%(request_id)s] %(name)s: %(message)s
```

时间格式为 `%Y-%m-%d %H:%M:%S%z`，包含时区信息。方括号中的 `%(request_id)s` 使得在海量日志中按 request ID 过滤变得简单——一个 `grep` 命令就能提取出某次请求在所有组件中的完整日志链路。

**为什么统一 uvicorn 日志格式？** FastAPI 底层使用 uvicorn 作为 ASGI 服务器。默认情况下，uvicorn 的 access log 和 error log 使用不同的格式，且不包含 request ID。OpenSandbox 在 `main.py` 中统一了 uvicorn.access 和 uvicorn.error 的日志格式和 handler，确保所有日志输出风格一致、都包含 request ID。

## 19.3 资源监控

execd 守护进程（运行在每个沙箱容器内部）提供了两个资源监控端点：

**快照端点 `GET /metrics`** 返回当前时刻的资源使用情况：

```json
{
    "cpu_cores": 4,
    "cpu_usage": 0.75,
    "memory_mib": 256.5,
    "timestamp": 1710892800000
}
```

其中 `cpu_usage` 是浮点数表示的 CPU 使用率（0.0 到核心数之间），`memory_mib` 是浮点数表示的内存使用量（MiB），`timestamp` 是毫秒级 Unix 时间戳。这个端点适合定期轮询式的监控采集。

**流式端点 `GET /metrics/watch`** 通过 SSE（Server-Sent Events）实时推送资源指标。每隔固定间隔（通常为秒级），服务器推送一个包含相同字段的 JSON 事件。

**为什么选择 SSE 而非 WebSocket？** SSE 是基于 HTTP 的单向流协议，天然与 HTTP 代理和负载均衡器兼容。WebSocket 需要协议升级，在某些代理配置下可能被阻断。对于指标推送这种单向数据流，SSE 的简单性是更好的选择。此外，SSE 内置了断线重连机制，客户端不需要自己实现重连逻辑。

## 19.4 状态追踪

`server/src/api/schema.py` 中的 `SandboxStatus` 模型记录了沙箱的生命周期状态：

```python
class SandboxStatus:
    state: str       # 7 种状态值
    reason: str      # 机器可读的原因码
    message: str     # 人类可读的描述信息
    last_transition_at: datetime  # 最近一次状态转换时间
```

七种状态值覆盖了沙箱的完整生命周期：

| 状态 | 含义 | 典型持续时间 |
|------|------|-------------|
| Pending | 正在创建，等待资源分配 | 秒到分钟级 |
| Running | 正常运行中 | 分钟到小时级 |
| Pausing | 正在暂停 | 秒级 |
| Paused | 已暂停，资源被冻结 | 不定 |
| Stopping | 正在停止 | 秒级 |
| Terminated | 已正常终止 | 终态 |
| Failed | 异常终止 | 终态 |

`reason` 字段提供机器可读的状态原因（如 `ImagePullFailed`、`OOMKilled`），方便自动化系统根据原因码进行决策。`message` 字段提供人类可读的详细描述。`last_transition_at` 记录最近一次状态变化的时间戳，可以用来检测"卡住"的沙箱——如果一个沙箱长时间处于 Pending 状态，可能存在资源不足或镜像拉取问题。

## 19.5 多层健康检查

OpenSandbox 的四个组件各自暴露独立的健康检查端点：

| 组件 | 端点 | 用途 |
|------|------|------|
| Lifecycle API (FastAPI) | `/health` | 服务器进程存活检查 |
| execd | `/ping` | 容器内执行守护进程存活检查 |
| ingress | `/status.ok` | 入站代理可用性检查 |
| egress | `/healthz` | 出站策略守护进程存活检查 |

**为什么每个组件使用不同的健康端点路径？** 这不是随意命名，而是遵循了各自生态的约定。`/health` 是 FastAPI 社区的常见约定；`/ping` 是轻量级服务的标准检查（Redis、Elasticsearch 也使用这个路径）；`/healthz` 是 Kubernetes 生态的标准路径名（`z` 代表 zero-config）；`/status.ok` 是负载均衡器常用的健康检查路径。遵循各自生态的约定，降低了运维人员的认知负担。

在 Kubernetes 部署中，这些端点配合 livenessProbe 和 readinessProbe 使用。如果 execd 的 `/ping` 无响应，Kubernetes 会重启容器；如果 ingress 的 `/status.ok` 返回失败，流量不会被路由到该实例。

## 19.6 未来：OpenTelemetry 集成

OSEP-0010 提案计划引入 OpenTelemetry instrumentation。当前的 X-Request-ID 方案虽然有效，但缺乏标准化的 span 树和跨进程 context propagation。OpenTelemetry 将带来：

- **分布式 Trace**：从 SDK 调用到 Lifecycle API 到 execd 的完整调用链，每个步骤的耗时清晰可见
- **标准化指标导出**：CPU、内存、请求延迟等指标可以导出到 Prometheus、Jaeger 等标准后端
- **自动 Instrumentation**：FastAPI、HTTP 客户端、K8s 客户端的自动埋点，无需手动添加追踪代码

这个演进方向反映了 OpenSandbox 从"可用"走向"可运维"的成熟度提升。

## 本章小结

OpenSandbox 的可观测性设计围绕四个维度展开：请求追踪通过 X-Request-ID 和 ContextVar 实现了异步安全的日志关联；资源监控通过 execd 的 metrics 端点和 SSE 流提供了实时可见性；SandboxStatus 的七种状态和结构化原因码使得生命周期变化可追踪；四层独立的健康检查确保了每个组件的故障可被及时发现。这些机制共同构成了生产环境中排查问题的基础能力，而 OSEP-0010 的 OpenTelemetry 计划将进一步提升可观测性的深度和标准化程度。
