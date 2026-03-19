# 第20章 生产部署最佳实践

> "Ship it, then iterate." —— Reid Hoffman

前面的章节深入分析了 OpenSandbox 的内部实现，而本章将视角切换到运维侧：如何将 OpenSandbox 从开发环境部署到生产环境？配置文件的优先级如何工作？Docker 和 Kubernetes 两种部署模式各有什么注意事项？10 个 OSEP 提案为项目未来描绘了怎样的路线图？

## 20.1 TOML 配置体系

OpenSandbox 的配置管理实现在 `server/src/config.py` 中，基于 Pydantic 模型和 TOML 文件格式。配置加载遵循三级优先级：

1. **CLI 参数**：`--config` 指定配置文件路径，优先级最高
2. **环境变量**：`SANDBOX_CONFIG_PATH` 指向配置文件
3. **默认路径**：`~/.sandbox.toml`

如果配置文件不存在，系统使用 Pydantic 模型中定义的默认值启动，而不会报错。这个设计让开发者可以零配置启动服务进行快速体验，同时为生产环境保留了完全的可定制性。

**为什么选择 TOML 而非 YAML 或 JSON？** TOML 的语法比 YAML 更严格（没有缩进敏感问题），比 JSON 更适合人类编辑（支持注释），且在 Python 生态中得到了标准库 `tomllib`（Python 3.11+）的原生支持。对于配置文件这种需要频繁人工编辑的场景，TOML 是更务实的选择。

## 20.2 配置分区详解

一个完整的生产配置文件包含以下分区：

**`[server]`**：FastAPI 服务器核心配置。`host` 和 `port` 定义监听地址，`log_level` 控制日志级别，`api_key` 设置认证密钥，`eip` 指定公网 IP（用于生成外部可访问的 endpoint URL），`max_sandbox_timeout` 限制沙箱最大存活时间。

**`[runtime]`**：运行时选择。`type` 为 `"docker"` 或 `"kubernetes"`，`execd_image` 指定 execd 守护进程的镜像路径。这个镜像在沙箱创建时被注入到容器中。

**`[docker]`**：Docker 后端特有配置。`network_mode` 控制网络模式（bridge/host），`api_timeout` 设置 Docker API 调用超时，`host_ip` 指定端口映射绑定的宿主机 IP，`pids_limit`（默认 512）限制容器内进程数量，`security` 子配置包含 `drop_capabilities`、`apparmor_profile`、`seccomp_profile` 和 `no_new_privileges`。

**`[kubernetes]`**：Kubernetes 后端配置。`kubeconfig` 指定集群认证文件路径，`informer` 控制是否启用缓存 + Watch 机制（启用后显著减少 API Server 压力），`rate_limiting` 配置令牌桶限流参数，`namespace` 指定沙箱运行的目标 namespace，`service_account` 指定 Pod 使用的 ServiceAccount，`workload_provider` 选择工作负载提供者（`batchsandbox` 或 `agent-sandbox`），`timeout` 配置 Pod 创建和就绪的超时时间。

**`[agent_sandbox]`**：Agent Sandbox 模式的专属配置（对应 OSEP-0002 kubernetes-sigs/agent-sandbox 支持）。`template` 定义 AgentSandbox 模板，`shutdown_policy` 控制关闭策略，`ingress` 配置入站访问方式。

**`[ingress]`**：入站流量配置。`mode` 为 `"direct"`（直连模式，适合 Docker 和开发环境）或 `"gateway"`（网关模式，适合 K8s 生产环境）。Gateway 模式需要配置 `domain` 或 `ip`，以及路由策略（wildcard / header / URI）。

**`[storage]`**：存储配置。`allowed_host_paths` 定义允许 bind mount 的宿主机路径白名单，`ossfs_mount_root` 指定 OSSFS 挂载的根目录。

**`[egress]`**：出站控制配置。`image` 指定 egress sidecar 镜像。只有配置了此镜像，网络策略功能才会生效。

**`[secure_runtime]`**：安全运行时配置。`type` 为 `gvisor`、`kata` 或 `firecracker`。`docker_runtime` 指定 Docker 中的 OCI runtime 名称（如 `runsc`），`k8s_runtime_class` 指定 Kubernetes RuntimeClass 名称。

Pydantic 验证器在配置加载时进行跨字段校验：Firecracker 必须搭配 Kubernetes 运行时；配置了 `[docker]` 分区时 `runtime.type` 必须为 `"docker"`；agent-sandbox 模式要求特定的 workload_provider 设置。这些校验在启动阶段就捕获配置错误，避免了运行时的意外行为。

## 20.3 CLI 工具与快速启动

安装和启动 OpenSandbox 服务器只需两步：

```bash
uv pip install opensandbox-server
opensandbox-server init-config --example docker --output sandbox.toml
opensandbox-server --config sandbox.toml
```

`server/src/cli.py` 使用 argparse 实现了两个子命令：

**`init-config`**：生成配置文件。支持三种模式——从内置示例复制（`--example docker`、`--example k8s` 等，中英文版本均可）、生成带注释的完整 schema skeleton、指定输出路径。示例配置文件位于 `server/example.config.toml` 和 `server/example.config.k8s.toml`。`render_full_config()` 函数从 Pydantic 模型动态生成配置骨架，将每个字段的描述作为 TOML 注释嵌入，类型信息作为占位符。

**默认启动命令**：启动 uvicorn 服务器。`--reload` 标志启用开发模式的热重载。配置路径通过 `--config` 参数或 `SANDBOX_CONFIG_PATH` 环境变量传递。

## 20.4 Docker 部署

Docker 部署适合单机开发、测试和小规模生产场景。

`server/Dockerfile` 定义了服务器镜像构建流程。`server/docker-compose.example.yaml` 提供了 docker-compose 编排模板，包含服务器和必要的依赖服务。

Docker 部署的关键注意事项：

- **网络模式选择**：bridge 模式支持网络隔离和 egress 策略；host 模式性能更好但无法使用网络策略。生产环境建议使用 bridge 模式。
- **安全运行时**：Docker 模式支持 gVisor 和 Kata，需要在宿主机上预先安装对应的 OCI runtime。
- **端口映射**：`docker.host_ip` 控制端口映射绑定的宿主机 IP。在多网卡环境中，应绑定到内网 IP 而非 `0.0.0.0`。

## 20.5 Kubernetes 部署

Kubernetes 部署适合多租户、大规模生产场景。部署资源位于 `kubernetes/charts/` 目录，包含三个 Helm chart：

- **opensandbox**：主 chart，包含完整部署
- **opensandbox-server**：仅部署 Lifecycle API 服务器
- **opensandbox-controller**：仅部署 Kubernetes Operator（管理 BatchSandbox 和 Pool CRD）

Operator 模式是 K8s 部署的推荐方式。控制器代码位于 `kubernetes/cmd/controller/` 和 `kubernetes/internal/controller/`，使用 Go 语言实现。它 watch BatchSandbox 和 Pool 资源的变更，自动完成 Pod 创建、任务分发和状态更新。

K8s 部署的关键配置：

- **kubeconfig vs ServiceAccount**：集群外部署使用 kubeconfig 认证；集群内部署（推荐）使用 Pod 自身的 ServiceAccount，更安全且不需要管理证书文件。
- **RuntimeClass 集成**：配置 `secure_runtime.k8s_runtime_class` 后，所有沙箱 Pod 的 `runtimeClassName` 会被设置为指定值，由 Kubernetes 调度到支持该运行时的节点上。
- **Namespace 策略**：建议为沙箱创建专用 namespace，配合 ResourceQuota 和 NetworkPolicy 实现租户隔离。

## 20.6 Code Interpreter 镜像

`sandboxes/code-interpreter/` 目录定义了 OpenSandbox 的默认沙箱镜像。采用两阶段构建：`Dockerfile_base` 构建包含所有语言运行时的基础镜像，`Dockerfile` 在此基础上添加 Jupyter 配置和启动脚本。

镜像支持多架构（amd64/arm64），通过 `build.sh` 脚本的 buildx 命令构建。预装的语言运行时包括：Python 3.10-3.14、Java 8/11/17/21、Node.js v18/v20/v22、Go 1.23-1.25。`scripts/code-interpreter-env.sh` 支持在运行时切换语言版本，无需重建镜像。

## 20.7 OSEP 路线图

OpenSandbox 通过 OSEP（OpenSandbox Enhancement Proposals）机制管理重大技术决策。`oseps/` 目录包含 10 个提案：

| OSEP | 标题 | 状态 | 核心内容 |
|------|------|------|---------|
| 0001 | FQDN-based Egress Control | 已实现 | DNS 拦截 + nftables 出站控制 |
| 0002 | kubernetes-sigs Agent Sandbox | 已实现 | 对接社区标准 CRD |
| 0003 | Volume Support | 实现中 | Host/PVC/OSSFS 卷挂载 |
| 0004 | Secure Container Runtime | 实现中 | gVisor/Kata/Firecracker 支持 |
| 0005 | Client-Side Sandbox Pool | 实现中 | SDK 层连接池管理 |
| 0006 | Developer Console | 可实现 | Web 开发控制台 |
| 0007 | Fast Sandbox Runtime | 暂定 | 亚秒级沙箱启动 |
| 0008 | Pause/Resume via Rootfs Snapshot | 草案 | 文件系统快照暂停恢复 |
| 0009 | Auto-Renew on Ingress Access | 实现中 | 有访问时自动续期 |
| 0010 | OpenTelemetry Instrumentation | 计划中 | 分布式追踪和指标标准化 |

OSEP-0007（Fast Sandbox Runtime）和 OSEP-0008（Pause/Resume）代表了性能优化方向——将沙箱启动时间从秒级压缩到亚秒级，对实时交互场景意义重大。

## 20.8 生产清单

部署到生产环境前的检查清单：

- [ ] 启用安全容器运行时（gVisor 或 Kata）
- [ ] 配置网络策略（默认拒绝出站 + FQDN 白名单）
- [ ] 设置资源限制（CPU/内存/PID）
- [ ] 配置 API Key 认证
- [ ] 启用日志收集和指标监控
- [ ] 设置合理的 `max_sandbox_timeout`
- [ ] 配置 `allowed_host_paths` 白名单（如使用 bind mount）
- [ ] 为 K8s 部署配置 ResourceQuota 和 NetworkPolicy
- [ ] 验证健康检查端点（`/health`、`/ping`、`/healthz`）
- [ ] 测试 egress 策略是否按预期工作

## 本章小结

OpenSandbox 的部署设计平衡了"快速体验"和"生产就绪"两个目标。TOML 配置文件通过三级优先级和 Pydantic 验证实现了灵活且安全的配置管理；CLI 工具的 `init-config` 命令降低了初始配置的门槛；Docker 和 Kubernetes 两种部署模式覆盖了从单机开发到多租户生产的全场景；Helm chart 和 Operator 将 Kubernetes 部署的复杂性封装为声明式资源。10 个 OSEP 提案展示了项目从安全加固、性能优化到可观测性提升的全方位演进路线。掌握本章内容，读者应能独立完成 OpenSandbox 在不同环境中的部署和配置。
