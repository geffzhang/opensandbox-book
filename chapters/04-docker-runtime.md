# 第4章 Docker 运行时后端

> "Complexity is not the enemy — unmanaged complexity is. A 2000-line file that tells a coherent story is better than 20 files that tell none." — 改编自 Rich Hickey

## 为什么从 Docker 后端读起

`server/src/services/docker.py` 是 OpenSandbox 中最大的单文件，约 2132 行代码。在上一章中我们提到，Docker 后端用一个文件封装了全部逻辑，而 Kubernetes 后端则拆分为 15 个文件。这并非疏忽 — Docker API 的抽象层级较低，容器创建、网络配置、卷管理和安全设置都在同一个 API 调用中完成，将这些紧密关联的逻辑放在一个文件中反而降低了认知负担。

## 类继承结构

```python
class DockerSandboxService(OSSFSMixin, SandboxService):
```

`DockerSandboxService` 通过多重继承组合了两个能力：`SandboxService` 抽象基类定义了生命周期接口（create、delete、pause、resume、get、list、renew），`OSSFSMixin` 则混入了 OSSFS（阿里云 OSS 文件系统）卷管理的 14 个方法。

为什么用 Mixin 而非组合模式？OSSFS 操作需要直接访问 Docker API client 和容器状态，如果封装为独立组件需要大量的上下文传递。Mixin 使得 OSSFS 方法可以直接访问 `self._docker_client` 和 `self._sandbox_expirations`，减少了胶水代码。

## 初始化流程

`__init__` 方法执行四个关键步骤：

1. **Docker 客户端初始化** — 调用 `docker.from_env()` 从环境变量（`DOCKER_HOST`、`DOCKER_TLS_CERTDIR`）创建客户端，API 超时默认 180 秒
2. **运行时类型验证** — 确认配置的运行时类型为 `"docker"`，否则直接抛出异常
3. **状态管理器初始化** — 创建线程安全的 `_sandbox_expirations` 字典和 `_expiration_timers` 计时器映射
4. **容器状态恢复** — `_restore_existing_sandboxes()` 在服务重启时扫描所有现存容器，重建过期计时器和 OSSFS 引用计数

状态恢复是容错设计的关键。如果 Lifecycle Server 崩溃重启，它不能丢失正在运行的沙盒的过期信息。恢复逻辑会先累积所有容器的 OSSFS 挂载引用计数，再启动过期计时器，避免在恢复过程中误删共享挂载。

## 容器创建九步流程

`create_sandbox()` 和内部的 `_provision_sandbox()` 方法实现了一个精心编排的九步创建流程：

**第一步：输入验证**。校验 entrypoint、metadata、超时时间、网络策略和卷配置。元数据过滤使用严格的键值对校验，拒绝格式错误的输入。

**第二步：上下文准备**。生成沙盒 ID、记录创建时间戳、计算过期时间。沙盒被加入 `_pending_sandboxes` 字典追踪创建中状态。

**第三步：镜像拉取**。支持 `ImageAuth` 认证的私有镜像拉取。execd 镜像使用内存缓存的 tar 归档，避免每次创建都重新读取磁盘。

**第四步：资源分配**。解析内存限制（字节）和 CPU 份额（nano 单位），为 execd 端口（44772）和 HTTP 端口（8080）分配宿主机端口。

**第五步：卷配置**。处理三种卷后端 — Host（直接绑定挂载）、PVC（Docker 命名卷）、OSSFS（S3 桶挂载）。每种后端有独立的验证逻辑，包括符号链接攻击防护。

**第六步：Sidecar 创建**。如果配置了网络策略，在 bridge 网络上启动 egress sidecar 容器。

**第七步：容器创建与启动**。构建包含安全选项的 host config，创建并启动容器。

**第八步：运行时注入**。将 execd 二进制文件和 bootstrap 脚本通过 `put_archive` API 注入容器。bootstrap 脚本包装了用户的原始 entrypoint，确保 execd 在容器启动时就开始运行。

**第九步：过期调度**。注册守护线程计时器，到期自动调用 `_expire_sandbox()` 销毁沙盒。

## 安全纵深配置

Docker 后端实现了多层安全加固，这些配置分布在 `_create_and_start_container()` 方法中：

**Capability 管理**。默认丢弃 9 项 Linux capabilities，当存在网络策略时额外丢弃 `NET_ADMIN`。这遵循最小权限原则 — 沙盒中的代码不需要修改网络接口或加载内核模块的能力。

**权限限制**。启用 `no_new_privileges=True`，防止沙盒中的进程通过 setuid/setgid 提升权限。这一行配置阻断了大量提权攻击路径。

**安全配置文件**。支持 AppArmor profile 和 Seccomp profile 注入，进一步限制系统调用范围。

**进程数限制**。`pids_limit=512` 防止 fork bomb 攻击耗尽系统资源。

**安全运行时**。通过 `SecureRuntimeResolver` 支持 gVisor（runsc）和 Kata Containers，在容器层面提供内核级隔离。

## 状态管理：线程安全的过期机制

沙盒的生命周期管理依赖三个线程安全的数据结构：

- `_sandbox_expirations: Dict[str, float]` — 记录每个沙盒的过期时间戳
- `_expiration_timers: Dict[str, Timer]` — 维护守护线程计时器
- `_pending_sandboxes: Dict[str, SandboxInfo]` — 追踪创建中的沙盒

`_schedule_expiration()` 方法在创建和续期时调用，它会取消现有计时器并创建新计时器，保证幂等性。计时器使用守护线程，当主进程退出时自动终止，不会导致僵尸线程。

创建失败的沙盒会被标记为 `Failed` 状态并保留在 `_pending_sandboxes` 中，通过 `_pending_cleanup_timers` 在 TTL（默认 3600 秒）后自动清理。这个设计允许客户端在创建失败后仍能查询到错误信息，而不是直接消失。

## 网络模式

Docker 后端支持两种网络模式：

**Host 模式**：容器直接共享宿主机网络栈，无端口映射开销。但不支持网络策略（因为无法为单个容器配置独立的出口规则）。端点地址为 `127.0.0.1:port`。

**Bridge 模式**（默认）：容器通过端口映射暴露服务。支持网络策略 — egress sidecar 与主容器共享同一 bridge 网络，拦截出站流量。端口映射信息存储在容器标签中，便于重启后恢复。

当配置了网络策略时，系统强制使用 bridge 模式，因为 host 模式下 sidecar 无法有效隔离流量。

## OSSFSMixin：引用计数的卷管理

`OSSFSMixin` 提供了 14 个方法管理 OSSFS 卷，核心挑战是 **共享挂载的生命周期管理**。多个沙盒可能挂载同一个 OSS 桶路径，直接卸载会影响其他沙盒。

解决方案是 **引用计数**。每次挂载时增加计数，每次释放时减少计数，只有当计数归零时才真正执行卸载操作。`_release_ossfs_mounts()` 方法在沙盒销毁时调用，确保计数安全递减。

Mixin 同时支持 OSSFS v1.0 和 v2.0 两个版本，提供 30 秒超时和失败回滚机制，以及注入攻击防护（验证路径参数不包含恶意字符）。

## 本章小结

Docker 后端通过一个约 2132 行的文件实现了完整的沙盒生命周期管理，包括九步容器创建流程、多层安全加固、线程安全的过期机制和引用计数的 OSSFS 卷管理。其设计处处体现了对安全性和容错性的重视 — 从 9 项 capability 丢弃到 `no_new_privileges` 限制，从状态恢复到失败沙盒的延迟清理。在下一章中，我们将看到 Kubernetes 后端如何用一套完全不同的抽象解决同样的问题。
