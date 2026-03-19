# 第8章 沙箱生命周期管理

> "万物皆有时——播种有时，收获有时；创建有时，销毁有时。" —— 改编自《传道书》

## 8.1 状态机：七种状态的流转

理解沙箱生命周期的关键，是理解其状态机。OpenSandbox 定义了七种沙箱状态，每种状态都记录在 `server/src/api/schema.py` 的 SandboxStatus 模型中：

```
Pending → Running → Stopping → Terminated
                  → Pausing  → Paused
Pending → Failed
```

- **Pending**：沙箱创建请求已接受，容器正在拉取镜像和启动
- **Running**：沙箱正常运行，可执行代码和文件操作
- **Pausing**：正在暂停中（过渡状态）
- **Paused**：已暂停，状态冻结但可恢复
- **Stopping**：正在停止中（过渡状态）
- **Terminated**：已终止，不可恢复
- **Failed**：创建失败，自动清理

SandboxStatus 不仅包含 `state` 字段，还附带 `reason`（机器可读的原因码）、`message`（人类可读的描述）和 `last_transition_at`（最近状态转换的时间戳）。这种丰富的状态信息让 SDK 能够向用户提供有意义的错误诊断，而非简单的"失败"二字。

为什么需要 Pausing 和 Stopping 这样的过渡状态？因为容器暂停和停止都不是瞬时操作。Docker 的 `pause` 命令需要冻结所有进程的 cgroup，`stop` 需要先发送 SIGTERM 等待优雅退出再强制 SIGKILL。在这些操作进行期间，API 需要向调用方传达"操作正在执行中"的语义，防止重复提交。

## 8.2 创建流程：从 SDK 到容器

沙箱创建是整个生命周期中最复杂的流程，涉及多层协作：

**第一步：SDK 发起请求。** 用户调用 `Sandbox.create()`，SDK 向 lifecycle server 发送 `POST /sandboxes` 请求，服务端立即返回 HTTP 202（Accepted）和 sandbox_id。202 而非 201 的语义至关重要——它告诉调用方"请求已接受，但创建尚未完成"。

**第二步：异步创建容器。** lifecycle server 的 `SandboxService.create_sandbox()` 在后台执行实际创建。对于 Docker 运行时（`server/src/services/docker.py`），流程包括：镜像拉取（优先使用本地缓存）→ 准备存储卷 → 构建安全配置（AppArmor、seccomp、capability dropping）→ 创建容器（注入 execd 守护进程和 bootstrap 脚本）→ 启动容器。对于 Kubernetes 运行时，则是：构建 Pod manifest → 创建 CRD 资源 → 等待 Pod 调度和就绪。

**第三步：SDK 轮询等待。** SDK 在收到 sandbox_id 后，调用 `check_ready()` 或 `waitUntilReady()` 反复查询沙箱状态，直到状态变为 Running 且健康检查通过。这个轮询间隔和超时都可配置。

在 Docker 运行时中，沙箱被标记为 Pending 状态直到容器完全就绪。如果创建过程中出现异常，Pending 记录会自动转为 Failed 状态，并在可配置的 TTL（默认 3600 秒）后被清理。这种设计确保了即使在网络抖动或系统崩溃的情况下，也不会永久留下僵尸状态。

## 8.3 过期管理：时间驱动的生命周期

每个沙箱在创建时都可以指定超时时间（最小 60 秒，最大值由服务端配置）。过期管理机制因运行时而异：

**Docker 运行时**使用内存中的定时器（`_schedule_expiration()`）。创建沙箱时计算 `expires_at` 时间戳并存储在容器 label 中，同时启动一个定时任务。定时器触发时，回调函数 `_expire_sandbox()` 会：验证沙箱未被续期 → 提取 OSSFS 挂载信息 → kill 容器 → 强制删除 → 释放挂载引用。将过期时间持久化到容器 label 中是一个关键设计——当 lifecycle server 重启时，`_restore_existing_sandboxes()` 方法会扫描所有运行中的容器，从 label 中恢复过期时间，重建定时器，同时立即终止已超期的容器。

**Kubernetes 运行时**则利用 CRD 中的 ExpireTime 字段，由 Kubernetes operator 负责在到期时清理资源。

**续期机制**通过 `renew-expiration` API 实现：SDK 调用 `renew(timeout)` → 服务端验证新过期时间在未来 → 更新内存状态和容器 label → 取消旧定时器 → 启动新定时器。此外，OSEP-0009 提出了"访问时自动续期"的增强方案，让沙箱在被活跃使用时自动延长生命周期。

沙箱也可以通过设置 manual cleanup 标签选择退出自动过期，此时必须由用户显式 delete。这为长期运行的开发环境提供了灵活性。

## 8.4 暂停与恢复

暂停/恢复是 OpenSandbox 的特色能力，允许用户在不销毁沙箱的前提下释放计算资源：

**Docker 运行时**直接使用 Docker 原生的 `pause` / `unpause` 命令。`docker pause` 通过 cgroup freezer 冻结容器内所有进程，内存状态完整保留但不消耗 CPU。`docker unpause` 解冻进程继续执行，整个过程对沙箱内的应用透明。`docker.py` 中的实现会严格检查前置状态：pause 要求容器处于 Running 状态，resume 要求容器处于 Paused 状态，否则返回 409 Conflict。

**Kubernetes 运行时**目前对 pause/resume 返回 501 Not Implemented。这并非技术上无法实现，而是 Kubernetes 原生不提供 Pod 级别的暂停原语。OSEP-0008 提出了基于 rootfs 快照的暂停/恢复方案——在暂停时对容器文件系统做快照，释放 Pod 资源，恢复时从快照重建容器。这是一个更具野心的方案，目前处于草案阶段。

## 8.5 代理访问机制

沙箱运行后，外部如何访问其内部服务？lifecycle server 内置了一个 HTTP 代理层，定义在 `server/src/api/lifecycle.py` 中：

```
GET/POST/PUT/DELETE/PATCH /sandboxes/{sandbox_id}/proxy/{port}/{path}
```

代理的工作流程是：接收外部请求 → 解析目标沙箱和端口 → 通过容器内部网络转发请求 → 以 `StreamingResponse` 异步流式返回响应。这种代理方式避免了直接暴露容器端口到公网的安全风险。

代理实现中有几个关键的安全措施：

1. **Hop-by-hop 头过滤**：按照 RFC 标准移除 `Connection`、`Keep-Alive`、`Transfer-Encoding` 等逐跳头，防止代理链中的头污染
2. **敏感头剥离**：代理转发时会过滤掉 `Authorization` 和 `Cookie` 头，防止凭据泄漏到沙箱内部
3. **WebSocket 拒绝**：当前实现显式拒绝 WebSocket 升级请求，这是一个有意识的安全边界——WebSocket 的长连接特性可能绕过超时和资源限制控制
4. **连接错误处理**：当后端沙箱不可达时，代理返回 502 Bad Gateway，而非让请求挂起

对于 Docker 运行时中使用网络策略的沙箱，存在一个精巧的网络架构：主沙箱容器加入一个 egress sidecar 容器的网络命名空间。sidecar 负责执行出口流量规则，而主容器共享 sidecar 的网络栈。端口映射分为两路——execd 端口（44772）和 HTTP 代理端口（8080），分别服务于内部控制和外部访问。

## 8.6 服务端重启恢复

生产环境中 lifecycle server 可能因升级或故障而重启。Docker 运行时的 `_restore_existing_sandboxes()` 方法确保了无损恢复：

1. 扫描所有带有 OpenSandbox label 的运行中容器
2. 从容器 label 中读取 sandbox_id 和 expires_at
3. 对未过期的沙箱重建过期定时器
4. 恢复 OSSFS 挂载的引用计数
5. 立即终止已过期的容器

这种基于容器 label 的持久化策略是一个务实的选择——无需外部数据库，所有状态元数据都随容器一起存储和迁移。

## 本章小结

沙箱生命周期管理的核心挑战在于**可靠性**——在分布式异步环境中确保每个沙箱都能被正确创建、准确追踪、按时回收。OpenSandbox 通过七状态机提供精确的状态语义，通过容器 label 持久化实现服务重启恢复，通过定时器加引用计数管理资源生命周期，通过代理层提供安全的沙箱访问。Docker 运行时的实现相对成熟完整，而 Kubernetes 运行时的暂停/恢复等高级功能仍在演进中——OSEP-0008 的 rootfs 快照方案将是下一个重要里程碑。
