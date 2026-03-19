# 第5章 Kubernetes 运行时后端

> "Kubernetes doesn't just run your containers — it becomes the operating system of your distributed application." — Kelsey Hightower

## 从 Docker 到 Kubernetes：复杂度跃迁

如果说 Docker 后端是"一个人的战斗"（单文件 2132 行），那么 Kubernetes 后端就是"一支军队的协作" — 15 个文件，涵盖 API 客户端、Informer 缓存、速率限制、工作负载抽象、CRD 管理等多个子系统。

为什么复杂度会急剧增加？根本原因在于 Kubernetes 的分布式特性。Docker 后端直接与本地 Docker daemon 通信，状态完全由自身管理。而 Kubernetes 后端面对的是一个最终一致的分布式系统 — API Server 可能过载、Watch 连接可能断开、Pod 调度可能延迟、资源版本可能过期。每一个故障模式都需要专门的应对机制。

## 核心类层次

```
KubernetesSandboxService
  └── K8sClient (lazy init)
        ├── CoreV1Api / CustomObjectsApi / NodeV1Api
        ├── WorkloadInformer (缓存)
        └── TokenBucketRateLimiter (限流)
  └── WorkloadProvider (抽象)
        ├── BatchSandboxProvider
        └── AgentSandboxProvider
  └── SecureRuntimeResolver
```

`KubernetesSandboxService`（定义在 `server/src/services/k8s/kubernetes_service.py`）实现了 `SandboxService` 接口，但将具体的工作负载操作委托给 `WorkloadProvider`。`K8sClient`（`k8s/client.py`）封装了所有 Kubernetes API 调用，提供统一的速率限制和缓存策略。

## K8sClient：统一的 API 访问层

`K8sClient` 的设计体现了几个重要的工程决策：

**懒加载 API 客户端**。`CoreV1Api`、`CustomObjectsApi` 和 `NodeV1Api` 三个客户端在首次使用时才初始化（lazy init），而非构造时创建。这避免了在配置尚未就绪时触发连接错误，也减少了不使用某些 API 时的资源浪费。

**kubeconfig 与 ServiceAccount 双模式**。客户端支持从 kubeconfig 文件加载配置（开发环境）或使用 Pod 内的 ServiceAccount token（生产环境），通过 `_load_config()` 自动检测。

**读写分离的速率限制**。`K8sClient` 维护两个独立的 `TokenBucketRateLimiter` 实例（定义在 `k8s/rate_limiter.py`），分别控制读操作和写操作的 QPS。为什么要分离？因为在 Kubernetes 中，写操作（创建 Pod、更新 CRD）对 API Server 的压力远大于读操作。分离限流允许系统在写操作繁忙时仍然保持读操作的响应性。

**Informer 缓存优先**。对于列表查询，`K8sClient` 首先尝试从 `WorkloadInformer` 的本地缓存中读取。只有当 Informer 尚未同步完成时，才回退到直接 API 调用。这个策略将列表查询的延迟从网络往返降低到内存访问。

## WorkloadInformer：Python 版 List-Watch

`k8s/informer.py` 中的 `WorkloadInformer` 是整个 Kubernetes 后端最精巧的组件。它用 Python 实现了 Kubernetes 原生的 List-Watch 模式 — 通常这种组件只在 Go 的 client-go 库中才能看到。

### 缓存结构

```python
_cache: Dict[str, Dict[str, Any]]  # 资源名 → 资源对象
```

缓存使用 `RLock`（可重入锁）保护，允许同一线程嵌套获取锁，避免了递归调用时的死锁风险。

### 三个核心循环

**`_full_resync()`** — 执行完整的 List 操作，用返回的资源列表替换整个缓存。这在启动时和 Watch 连接丢失时触发。

**`_run_watch_loop()`** — 基于上次的 `resource_version` 建立 Watch 流，持续接收增量事件。这是稳态下的主要数据更新路径。

**`_handle_event()`** — 处理三种事件类型：`ADDED` 和 `MODIFIED` 将对象 upsert 到缓存中，`DELETED` 从缓存中移除对象。

### 资源版本的单调性检查

`_advance_resource_version()` 方法实现了一个巧妙的保护机制：它将 `resource_version` 当作不透明字符串处理（符合 Kubernetes API 约定），但尝试将其解析为整数进行比较。只有当新版本严格大于当前版本时才更新，防止时间倒流导致缓存状态回退。对于无法解析为整数的版本（理论上不应出现，但需要防御性编程），保守地跳过更新。

### 指数退避与 410 Gone 处理

当 Watch 连接出现错误时，Informer 使用 **指数退避** 重试：初始等待 1 秒，每次翻倍，上限 30 秒。成功后重置为 1 秒。

特别值得关注的是 **410 Gone** 错误的处理。这个错误表示 API Server 已经丢弃了请求的 `resource_version` 对应的事件历史（通常因为 etcd compaction）。Informer 的响应是触发一次完整的 `_full_resync()`，重建缓存并获取最新的 `resource_version`。这是 Kubernetes 控制器编程中的标准模式，OpenSandbox 在 Python 中忠实地复现了它。

## BatchSandbox CRD

Kubernetes 后端通过自定义资源定义（CRD）管理沙盒。`BatchSandbox` 是核心 CRD，其 spec 包含以下关键字段：

- **Replicas** — 副本数，支持批量创建
- **PoolRef** — 关联的资源池引用（Pool 模式）
- **Template** — Pod 模板，包含容器定义、卷、资源限制
- **ShardPatches** — 分片补丁，支持按副本定制配置
- **ExpireTime** — 过期时间戳，由 Operator 监控并执行清理
- **TaskTemplate** — Pool 模式下的任务模板
- **TaskResourcePolicyWhenCompleted** — 任务完成后资源策略：`Retain`（保留）或 `Release`（释放）

配套的 `Pool` CRD 定义了资源池的容量策略：`BufferMax/Min` 控制预热缓冲数量，`PoolMax/Min` 控制池的总体规模。Pool 模式通过预先创建容器显著降低了沙盒的冷启动延迟。

## BatchSandboxProvider：模板与池双模式

`k8s/batchsandbox_provider.py`（约 821 行）实现了 `WorkloadProvider` 接口，支持两种创建模式：

### 模板模式（默认）

用户完全控制 Pod 定义 — 指定镜像、资源限制、环境变量、卷挂载和网络策略。Provider 在用户配置基础上注入 execd init container：

```yaml
initContainers:
  - name: execd-installer
    image: <execd-image>
    volumeMounts:
      - name: opensandbox-bin
        mountPath: /opt/opensandbox/bin
```

init container 将 execd 二进制和 `bootstrap.sh` 脚本复制到共享的 `emptyDir` 卷中。主容器的 entrypoint 被包装为 `["/opt/opensandbox/bin/bootstrap.sh"] + original_entrypoint`，参数通过 `shlex.quote()` 转义防止 shell 注入。

### 池模式

当 `extensions['poolRef']` 存在时激活。池模式引用预热的资源池，仅允许定制 entrypoint 和环境变量，**不支持自定义卷**。任务通过 `TaskSpec` 结构描述，bootstrap 脚本以后台模式运行：`"/opt/opensandbox/bin/bootstrap.sh {entrypoint} &"`。

池模式的限制是有意为之的。预热池中的容器已经分配了资源和卷，运行时修改这些配置会打破池的同质性假设，导致调度和回收逻辑复杂化。

## 沙盒创建等待与超时

`KubernetesSandboxService` 中的 `_wait_for_sandbox_ready()` 实现了阻塞式轮询等待：

- **超时时间**：通过 `app_config.kubernetes.sandbox_create_timeout_seconds` 配置，默认 60 秒
- **轮询间隔**：通过 `app_config.kubernetes.sandbox_create_poll_interval_seconds` 配置，默认 1.0 秒
- **成功条件**：工作负载状态为 `Running` 或 `Allocated`（已分配 IP）
- **失败处理**：超时后自动调用 `delete_workload()` 清理资源，返回 HTTP 504

为什么选择轮询而非 Watch？因为创建等待是一个短期、低频的操作，为每次创建建立独立的 Watch 连接开销过大。而 Informer 的缓存更新有固有延迟，可能导致状态判断不够及时。直接轮询 API 在这个场景下是更简单可靠的选择。

## 暂停/恢复：501 与未来计划

Kubernetes 后端的 `pause_sandbox()` 和 `resume_sandbox()` 均返回 **HTTP 501 Not Implemented**。这是一个诚实的技术决策 — Kubernetes 缺乏原生的 Pod 暂停/恢复语义。

OSEP-0008 提出了基于 **rootfs 快照** 的解决方案：将容器的文件系统状态快照保存，销毁 Pod 释放计算资源，恢复时从快照创建新 Pod。这种方式在 Kubernetes 的约束下实现了"伪暂停"，但涉及快照存储、状态一致性和恢复延迟等复杂问题，目前仍处于草案阶段。

## 本章小结

Kubernetes 后端通过 K8sClient 统一 API 访问、WorkloadInformer 实现 Python 版 List-Watch、BatchSandboxProvider 支持模板与池双模式，构建了一个完整的分布式沙盒管理系统。读写分离的速率限制、指数退避重试、410 Gone 自动重同步等机制体现了对 Kubernetes 分布式故障模式的深刻理解。暂停/恢复功能的 501 返回和 OSEP-0008 提案则展示了项目在技术诚实和渐进式演进之间的平衡。
