# 第18章 多租户与安全隔离

> "Security is not a product, but a process." —— Bruce Schneier

沙箱的本质是一个安全边界。当多个租户共享同一套 OpenSandbox 基础设施时，每个租户的代码都可能包含恶意或有缺陷的逻辑。OpenSandbox 的安全设计遵循"纵深防御"原则——从容器运行时到 Linux 内核安全、从网络隔离到 API 认证、从输入验证到路径遍历防护，构建了多层交叉的安全屏障。

## 18.1 三种安全容器运行时

OpenSandbox 支持三种安全容器运行时，定义在 `server/src/config.py` 的 `SecureRuntimeConfig` 类型中：

| 运行时 | 隔离机制 | Docker 支持 | K8s 支持 | 适用场景 |
|--------|---------|------------|----------|---------|
| **gVisor** | 用户空间内核拦截系统调用 | docker_runtime | k8s_runtime_class | 高安全要求、低开销 |
| **Kata Containers** | 轻量级虚拟机 | docker_runtime | k8s_runtime_class | VM 级隔离、兼容性好 |
| **Firecracker** | microVM | 不支持 | k8s_runtime_class | 极致安全、仅 K8s |

**为什么需要安全运行时？** 标准 Linux 容器共享宿主机内核。如果容器内的代码利用内核漏洞实现逃逸，宿主机上所有容器都会受到威胁。gVisor 在用户空间实现了一个精简的内核接口，系统调用不直接到达宿主机内核；Kata 和 Firecracker 则通过虚拟化提供完全的内核隔离。

启动时，`validate_secure_runtime_on_startup()` 函数会验证配置的运行时是否在当前环境中可用。例如，如果配置了 gVisor 但 Docker 中未安装 runsc runtime，服务会在启动阶段就报错，而非等到创建沙箱时才失败。这种 fail-fast 策略避免了运行时的意外错误。

## 18.2 Linux 安全加固

即使不使用安全运行时，OpenSandbox 也通过多项 Linux 安全机制加固容器。这些配置在 `server/src/services/docker.py` 的 `_base_host_config_kwargs()` 方法和 `server/src/config.py` 的 `DockerConfig` 中定义：

**Capabilities 裁剪**：Linux capabilities 将 root 权限拆分为细粒度的能力集。OpenSandbox 默认丢弃 9 个危险 capability，包括 `NET_RAW`（防止原始套接字嗅探）、`SYS_ADMIN`（防止挂载和 namespace 操作）等。只有 egress sidecar 容器被授予 `NET_ADMIN` 以管理网络策略，主容器从不获得此权限。

**no_new_privileges**：`DockerConfig.no_new_privileges` 默认为 `True`。这个 Linux 内核标志确保进程及其子进程不能通过 execve 获取额外权限，即使执行了 setuid 二进制文件也无效。这堵住了容器内通过 SUID 提权的攻击路径。

**AppArmor 和 Seccomp profiles**：可选配置。AppArmor 限制进程可以访问的文件路径和网络操作；Seccomp 限制进程可以调用的系统调用集合。两者结合可以将容器的攻击面收窄到最小必要范围。

**PID 限制**：`pids_limit` 默认 512。这防止 fork 炸弹攻击——恶意代码无限 fork 进程以耗尽系统资源。512 个进程足以运行正常的开发和评估任务，但远不足以对宿主机构成威胁。

## 18.3 网络隔离与出站控制

网络隔离是多租户安全的关键防线。OpenSandbox 的网络策略实现了三个层次的控制，核心逻辑在 `components/egress/` 目录中：

**默认拒绝出站**：沙箱容器默认不允许任何出站网络访问。这是最安全的默认策略——除非明确允许，否则容器无法访问外部网络。

**FQDN 粒度的访问控制**：管理员可以配置允许访问的域名列表（而非 IP 地址）。这对 AI Agent 场景特别重要——Agent 可能需要访问特定 API（如 api.openai.com），但不应该能访问任意互联网地址。

**DNS 拦截防绕过**：egress sidecar（`components/egress/nameserver.go`）在容器网络命名空间内运行 DNS 代理，拦截所有 DNS 查询。不在白名单中的域名查询直接返回 `NXDOMAIN`。这防止了通过硬编码 IP 地址绕过域名限制的攻击——在 `dns+nft` 模式下，`components/egress/nft.go` 使用 nftables 在内核层面只允许 DNS 解析出的 IP 通过，并按 TTL 自动过期。

这种 DNS 层 + 内核层的双重防线设计，是 OSEP-0001 (FQDN-based Egress Control) 提案的核心贡献。

## 18.4 三层 API 认证体系

OpenSandbox 的三个组件（Lifecycle API、execd、egress）各有独立的认证机制，形成纵深的身份验证链：

**第一层：Lifecycle API Key**。Header 名为 `OPEN-SANDBOX-API-KEY`，在 `server/src/middleware/auth.py` 的 `AuthMiddleware` 中实现。健康检查（`/health`）、API 文档（`/docs`、`/redoc`）和代理路径被豁免认证。代理路径通过严格的正则表达式 `^(/v1)?/sandboxes/[^/]+/proxy/\d+(/|$)` 匹配，拒绝包含 `..` 的路径遍历尝试。

**第二层：execd Access Token**。Header 名为 `X-EXECD-ACCESS-TOKEN`，令牌在沙箱创建时由 Lifecycle API 自动生成并注入到容器环境变量中。这确保只有通过正当途径创建的沙箱才能接受执行命令——即使攻击者发现了 execd 的端口，没有令牌也无法执行任何操作。

**第三层：Egress Auth Token**。Header 名为 `OPENSANDBOX-EGRESS-AUTH`，用于保护 egress sidecar 的策略 API。关键实现细节是使用**常量时间比较**（constant-time comparison）验证令牌，防止时序攻击——攻击者无法通过测量响应时间来逐字符猜测令牌。

**为什么每层使用不同的 Header 名？** 这是有意为之的安全设计。如果三层使用同一个认证机制，一旦某层的令牌泄露，攻击者就能访问所有层。独立的令牌确保了安全域的分离——即使 execd 令牌泄露，攻击者也无法修改 egress 策略。

## 18.5 输入验证与注入防护

`server/src/services/validators.py` 包含了全面的输入验证逻辑，覆盖了多个攻击向量：

**OSSFS 注入防护**：OSSFS 挂载需要构建命令行参数，包括 bucket 名、endpoint、挂载选项等。如果这些参数未经验证就拼接到命令中，攻击者可以注入额外的命令。验证器对 bucket 名强制 DNS 命名规范，对 endpoint 验证 URL 格式，对挂载选项检查是否包含危险字符。`server/src/services/ossfs_mixin.py` 中的 OSSFSMixin 通过 14 个方法实现了从路径解析到命令构建的完整安全链。

**Host Path 白名单**：Docker 后端的 bind mount 通过 `StorageConfig.allowed_host_paths` 配置允许挂载的宿主机路径前缀。验证器检查请求的路径是否以白名单中的某个前缀开头，拒绝非规范化路径（如包含 `//` 的路径）和路径遍历（`..`）。

**镜像认证**：`ImageAuth` 类型支持私有镜像仓库的认证信息。验证器确保认证数据格式正确，防止格式错误的认证信息导致的安全问题。

**保留标签前缀**：以 `opensandbox.io/` 为前缀的标签是系统保留标签。验证器拒绝用户设置这些标签，防止通过伪造系统标签来干扰内部逻辑。

## 18.6 多租户隔离架构

在 Kubernetes 后端，OpenSandbox 通过多重机制实现租户隔离：

**容器级隔离**：每个沙箱运行在独立的 Pod 中。即使两个租户的沙箱调度到同一个节点，Linux namespace 和 cgroup 也确保它们互不可见。

**Namespace 隔离**：通过 `KubernetesRuntimeConfig` 中的 namespace 配置，不同租户的沙箱可以运行在不同的 Kubernetes namespace 中。结合 NetworkPolicy，namespace 之间的网络流量被完全隔离。

**ServiceAccount 配置**：`KubernetesRuntimeConfig.service_account` 允许为沙箱 Pod 指定最小权限的 ServiceAccount。默认的 ServiceAccount 不应有任何 RBAC 权限，确保沙箱内的代码无法通过 Kubernetes API 访问集群资源。

**资源配额**：通过 Kubernetes 的 ResourceQuota 机制（在 namespace 层面配置），限制每个租户可以使用的总 CPU、内存和 Pod 数量，防止单个租户耗尽集群资源。

## 本章小结

OpenSandbox 的安全设计体现了"纵深防御"的核心理念。三种安全容器运行时提供了从 syscall 拦截到 VM 隔离的不同安全级别；Linux 安全机制（capabilities 裁剪、no_new_privileges、AppArmor、Seccomp、PID 限制）在内核层面收窄攻击面；网络隔离通过 DNS 拦截和 nftables 实现 FQDN 粒度的出站控制；三层独立的 API 认证阻止了跨安全域的攻击扩散；输入验证则在应用层堵住了注入和遍历攻击。理解这些安全层次之间的协作关系，对于在生产环境中安全运行多租户沙箱至关重要。
