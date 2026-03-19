# 第13章 资源限制与配额

> "资源是有限的，欲望是无穷的。工程师的工作就是在两者之间找到平衡点。"
> —— Frederick Brooks

AI 沙箱面临一个独特的挑战：运行的代码来自 AI Agent 的生成，其行为不可预测——可能是一个简单的 Python 脚本，也可能是一个意外的死循环或内存泄漏。OpenSandbox 在 API 层、Docker 运行时和 Kubernetes 调度三个层面构建了完整的资源限制体系，确保单个沙箱的资源消耗不会影响整个平台的稳定性。

## API 层：灵活的键值模型

OpenSandbox 的资源限制在 API 层采用了极简的键值对模型。`ResourceLimits` 被定义为 `RootModel[Dict[str, str]]`，一个完全开放的字符串字典：

```python
resource_limits = {
    "cpu": "500m",
    "memory": "512Mi",
    "gpu": "1"
}
```

为什么不定义强类型的 schema（如专门的 `cpu_cores`、`memory_bytes` 字段）？因为资源类型是不断扩展的。今天是 CPU 和内存，明天可能是 GPU、FPGA、网络带宽。键值对模型让 API 层保持稳定，新资源类型的支持只需要在运行时层添加解析逻辑，无需修改 API 协议。这种设计借鉴了 Kubernetes 资源模型的思路——扩展性优先。

## Docker 层：精确的资源解析

当请求到达 Docker 运行时后端（`server/src/services/docker.py`），灵活的字符串值需要被转换为 Docker API 理解的精确数值。两个核心解析函数在 `server/src/services/helpers.py` 中实现。

### CPU 解析：parse_nano_cpus()

CPU 限制支持两种格式：毫核（如 `500m` 表示半个 CPU 核心）和整数核心（如 `2` 表示两个核心）。`parse_nano_cpus()` 将它们统一转换为纳秒级 CPU 时间，这是 Docker API 的原生单位。`500m` 转换为 `500,000,000` 纳秒（即 0.5 核），`2` 转换为 `2,000,000,000` 纳秒（即 2 核）。

为什么单独提供解析函数而非内联处理？因为资源值的格式来自用户输入（可能是 Kubernetes 风格的 `500m`，也可能是直觉的 `0.5`），解析逻辑需要处理多种边界情况。独立的函数便于单元测试，也便于未来支持更多格式。

### 内存解析：parse_memory_limit()

内存限制支持 Kubernetes 标准后缀：`Ki`（1024 字节）、`Mi`（1048576 字节）、`Gi`（约 10 亿字节）、`Ti`（约 1 万亿字节）。`parse_memory_limit()` 将它们转换为字节数。例如 `512Mi` 转换为 `536,870,912` 字节。

这些解析后的数值注入 Docker 的 host config：

```python
if mem_limit:
    host_config_kwargs["mem_limit"] = mem_limit
if nano_cpus:
    host_config_kwargs["nano_cpus"] = nano_cpus
```

## 安全加固：九层防护

Docker 层的资源限制不仅限于 CPU 和内存，`_base_host_config_kwargs()` 方法构建了完整的安全配置：

### PID 限制

`pids_limit=512` 是容器内的进程数上限。为什么是 512？这个值经过权衡：常规开发工作负载（编译、测试、包安装）通常不会超过几十个进程；512 给了充足的余量，同时有效阻止了 fork 炸弹——一段简单的 `while True: os.fork()` 代码在 512 个进程后就会被内核拒绝。

### 能力丢弃

默认丢弃 9 个 Linux capabilities，包括 `NET_ADMIN`（网络配置）、`SYS_ADMIN`（系统管理）等高危权限。AI 生成的代码不应该能修改网络路由表、挂载文件系统或加载内核模块。丢弃这些能力将攻击面最小化。

### 权限升级阻止

`no_new_privileges: true` 阻止容器内进程通过 setuid/setgid 二进制文件获取额外权限。即使容器内存在 setuid 程序（如某些包管理器），也无法提权。

### 强制访问控制

AppArmor profile 和 Seccomp profile 提供了系统调用级别的过滤。AppArmor 限制文件访问路径和网络行为，Seccomp 限制可用的系统调用集合。两者都通过配置文件指定，允许运维人员根据使用场景调整安全策略：

```python
if docker_cfg.apparmor_profile:
    security_opts.append(f"apparmor={docker_cfg.apparmor_profile}")
if docker_cfg.seccomp_profile:
    security_opts.append(f"seccomp={docker_cfg.seccomp_profile}")
```

## Kubernetes 层：弹性资源池

在 Kubernetes 运行时中，资源管理上升到集群调度层面。

### Pod 资源配额

每个沙箱 Pod 通过 `resourceRequests` 和 `resourceLimits` 设置资源配额。Requests 是 Kubernetes 调度器的最低保证——调度器确保节点有足够资源满足 request；Limits 是硬上限——超出后容器被 OOM Kill 或 CPU 限流。

`ExecdInitResources` 为 init container（负责初始化 execd 二进制文件）单独配置资源，避免 init 阶段的临时高资源消耗影响沙箱 Pod 的调度决策。

### Pool CRD：容量管理

Pool CRD（`kubernetes/apis/sandbox/v1alpha1/pool_types.go`）定义了资源池的弹性伸缩参数：

- **BufferMax/BufferMin**：预热节点的数量范围。预热节点是已创建但未分配的沙箱，用于实现秒级启动。BufferMin 确保始终有一定数量的热备沙箱，BufferMax 控制预热成本。
- **PoolMax/PoolMin**：资源池总容量的范围。PoolMax 防止无限扩容，PoolMin 保证最低服务能力。

所有值都有 `minimum: 0` 的 schema 验证，防止负数配置导致控制器异常。Pool 的 Status 字段实时报告 `Total`（总数）、`Allocated`（已分配）、`Available`（可用），为运维监控提供数据基础。

## 超时限制：时间维度的资源管理

资源不仅是 CPU 和内存，时间也是关键资源。OpenSandbox 在 `server/src/config.py` 中定义了多层超时：

| 配置项 | 默认值 | 作用 |
|--------|--------|------|
| `max_sandbox_timeout_seconds` | 可选（最小 60s） | 沙箱生命周期上限 |
| `sandbox_create_timeout_seconds` | 60s | 创建等待超时 |
| `sandbox_create_poll_interval_seconds` | 1.0s | 创建状态轮询间隔 |
| `api_timeout`（Docker） | 180s | Docker API 调用超时 |

`max_sandbox_timeout_seconds` 是服务端的强制上限，客户端请求的超时不能超过此值。最小 60 秒的限制防止用户设置过短的超时导致沙箱启动都来不及完成。创建超时和轮询间隔的分离设计让系统在等待容器就绪时既不频繁轮询浪费 CPU，又能在合理时间内检测到就绪状态。

## 运行时监控：实时资源感知

execd 组件通过 `components/execd/pkg/web/controller/metric.go` 提供了两种监控接口：

- **GET /metrics**：返回当前时刻的 CPU 核心数（`runtime.GOMAXPROCS()`）、CPU 使用率（gopsutil `cpu.Percent()`）、内存使用量（MiB）和时间戳。
- **GET /metrics/watch**：基于 SSE（Server-Sent Events）的实时监控流，每秒推送一次指标数据。客户端通过标准的 EventSource API 订阅，连接断开自动停止推送。

为什么选择 SSE 而非 WebSocket？SSE 是单向推送，语义更匹配监控场景（服务器向客户端推数据）；SSE 基于 HTTP，无需升级协议，穿透代理更容易；且 SSE 内建重连机制，网络抖动后自动恢复。

监控数据使客户端 SDK 能够在资源接近限额时做出预防性决策，例如在内存接近上限前主动释放缓存或终止内存密集型任务。

## 本章小结

OpenSandbox 的资源管理体系体现了 **分层防御** 的设计哲学：API 层提供灵活的键值模型保证扩展性，Docker 层将其转化为精确的运行时约束（CPU/内存/PID/能力/权限），Kubernetes 层在集群维度实现弹性调度和容量管理，超时体系从时间维度约束资源使用。每一层都假设上一层可能失效，提供独立的保护。关键源码路径：`server/src/api/schema.py`（API 模型）、`server/src/services/helpers.py`（资源解析）、`server/src/services/docker.py`（Docker 安全配置）、`server/src/config.py`（超时与默认值）、`kubernetes/apis/sandbox/v1alpha1/pool_types.go`（Pool CRD）、`components/execd/pkg/web/controller/metric.go`（运行时监控）。
