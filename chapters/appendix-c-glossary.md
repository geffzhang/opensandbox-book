# 附录C 名词解释

本附录收录全书涉及的核心技术术语，按英文名称字母顺序排列。每个条目包含英文原名、中文翻译和在 OpenSandbox 语境下的含义说明。

---

**AppArmor** — Linux 安全模块

Linux 内核的强制访问控制（MAC）框架。通过为每个程序定义安全配置文件（profile），限制其可以访问的文件路径、网络端口和系统能力。在 OpenSandbox 中，AppArmor 作为安全纵深防御的一层，约束沙箱容器内进程的行为边界，防止恶意代码突破容器隔离后访问宿主机敏感资源。

**BatchSandbox** — 批量沙箱 CRD

OpenSandbox 定义的 Kubernetes 自定义资源，用于声明式地批量创建沙箱实例。相比逐个调用 API 创建，BatchSandbox 通过单个资源对象描述一组沙箱的模板和数量，由 Operator 并行调度创建，显著提升大规模场景下的初始化效率。

**Bootstrap Script** — 引导脚本

沙箱容器启动后自动执行的初始化脚本。用于安装依赖包、配置环境变量、拉取数据等准备工作。Bootstrap Script 在 execd 启动之前运行，确保沙箱就绪时已具备业务所需的运行环境。

**CRD (Custom Resource Definition)** — 自定义资源定义

Kubernetes 的扩展机制，允许用户定义新的 API 资源类型。OpenSandbox 通过 CRD 注册了 Sandbox、BatchSandbox、Pool 等资源类型，使沙箱管理完全融入 Kubernetes 的声明式生态，可以使用 kubectl 和标准 API 进行操作。

**DevTools Protocol** — Chrome 开发者工具协议

Chrome 浏览器暴露的远程调试协议，基于 WebSocket 通信。OpenSandbox 利用此协议在沙箱内的 Chromium 实例上实现浏览器自动化操作，包括页面导航、DOM 操作、截图和网络拦截，为 AI Agent 提供网页交互能力。

**DNS-over-HTTPS (DoH)** — HTTPS 上的 DNS

将 DNS 查询封装在 HTTPS 请求中传输的协议。OpenSandbox 的 Egress 组件支持 DoH 来加密沙箱的 DNS 解析过程，防止 DNS 查询被中间人窃听或篡改，同时配合 FQDN 过滤策略实施精确的出站域名控制。

**DNS-over-TLS (DoT)** — TLS 上的 DNS

与 DoH 类似的 DNS 加密传输方案，使用专用的 853 端口通过 TLS 隧道传输 DNS 查询。OpenSandbox 同时支持 DoT 和 DoH 两种方案，运维人员可根据网络环境灵活选择。

**Egress** — 出站流量

从沙箱内部向外部网络发送的流量。OpenSandbox 提供精细化的 Egress 控制机制，通过 FQDN 白名单、NetworkPolicy 和 nftables 规则限制沙箱可以访问的外部服务，是防止数据泄露和恶意外联的核心安全能力。

**execd** — 执行守护进程

运行在每个沙箱容器内部的守护进程，是沙箱执行能力的核心载体。execd 对外暴露 HTTP API，提供命令执行、代码运行、文件操作和资源监控等功能。它负责与 Jupyter Kernel 通信实现多语言代码执行，并通过 SSE 将执行结果实时推送给客户端。

**FQDN (Fully Qualified Domain Name)** — 完全限定域名

包含所有层级标签的完整域名，例如 `api.example.com`。OpenSandbox 的 Egress 策略基于 FQDN 而非 IP 地址进行出站过滤，因为云环境中 IP 地址频繁变化，而 FQDN 更稳定也更具可读性。

**gVisor** — Google 用户态内核

Google 开源的应用内核，在用户态拦截并重新实现 Linux 系统调用。与传统容器共享宿主机内核不同，gVisor 为每个容器提供独立的内核接口，大幅缩小攻击面。OpenSandbox 推荐在执行不可信代码的场景中使用 gVisor 作为 OCI Runtime。

**Helm Chart** — Kubernetes 包管理模板

Kubernetes 应用的打包格式，将多个 YAML 资源文件组织为可参数化的模板集合。OpenSandbox 提供官方 Helm Chart，用户通过调整 `values.yaml` 中的配置项即可完成定制化部署，涵盖组件副本数、资源配额、安全策略等所有运维参数。

**Informer** — Kubernetes Watch 缓存机制

Kubernetes client-go 库中的核心组件，通过 List-Watch 模式在本地维护资源对象的缓存副本。OpenSandbox 的 Operator 使用 Informer 监听 Sandbox 和 Pool 资源的变化事件，避免频繁请求 API Server，同时保证事件处理的可靠性和顺序性。

**Ingress** — 入站流量

从外部网络进入沙箱的流量。OpenSandbox 的 Ingress 组件作为反向代理网关，负责将客户端请求路由到正确的沙箱实例，同时处理认证、TLS 终止和 WebSocket 升级等横切关注点。

**Jupyter Kernel** — Jupyter 计算内核

Jupyter 架构中负责实际代码执行的后端进程。每种编程语言对应一个 Kernel 实现（如 IPython Kernel 用于 Python）。OpenSandbox 的代码解释器复用 Jupyter Kernel 协议，在沙箱内启动 Kernel 进程并通过 ZeroMQ 协议通信，实现多语言代码的交互式执行。

**Kata Containers** — 轻量级虚拟机容器

将每个容器运行在独立轻量级虚拟机中的容器运行时。相比 gVisor 的用户态拦截方案，Kata Containers 通过硬件虚拟化提供更强的隔离保障，代价是略高的资源开销和启动延迟。适用于对隔离安全性要求极高的场景。

**MCP (Model Context Protocol)** — 模型上下文协议

Anthropic 提出的开放协议标准，定义大语言模型与外部工具之间的标准化通信接口。OpenSandbox 实现了 MCP Server，使 AI Agent 能够通过统一协议调用沙箱的代码执行、文件操作和浏览器控制等能力，无需针对不同模型编写适配代码。

**NetworkPolicy** — 网络策略

Kubernetes 原生的网络访问控制资源，基于标签选择器定义 Pod 之间及 Pod 与外部的通信规则。OpenSandbox 自动为每个沙箱生成 NetworkPolicy，结合 Egress 组件的应用层策略实现多层网络隔离。

**nftables** — Linux 内核包过滤框架

Linux 内核中 iptables 的继任者，提供更高效的包过滤和网络地址转换能力。OpenSandbox 的 Egress 组件使用 nftables 在内核层面实施出站流量拦截规则，配合用户态的 FQDN 解析实现精确的域名级出站控制。

**OCI Runtime** — 开放容器运行时

Open Container Initiative 定义的容器运行时标准。runc 是默认的 OCI Runtime 实现，而 gVisor（runsc）和 Kata Containers 是安全增强的替代实现。OpenSandbox 通过 Kubernetes RuntimeClass 机制支持在不同沙箱中使用不同的 OCI Runtime。

**OpenAPI** — 开放 API 规范

描述 RESTful API 的行业标准规范格式（原 Swagger）。OpenSandbox 采用 Protocol-First 设计方法，先编写 OpenAPI 定义文件，再基于该定义生成服务端框架和多语言 SDK，确保 API 文档与实现始终保持一致。

**OSEP (OpenSandbox Enhancement Proposal)** — OpenSandbox 增强提案

OpenSandbox 社区的设计提案机制，参考 Kubernetes KEP 和 Python PEP 的流程。重大功能变更需先提交 OSEP 文档，经社区讨论和审批后方可进入实现阶段，确保架构演进的审慎性和透明度。

**OSSFS** — 阿里云 OSS FUSE 文件系统

将阿里云对象存储（OSS）挂载为本地文件系统的 FUSE 驱动。OpenSandbox 支持通过 OSSFS 为沙箱挂载持久化存储，使沙箱内的文件操作可以透明地持久化到云存储，解决容器短暂生命周期与数据持久化之间的矛盾。

**Pool** — 预热池

OpenSandbox 的资源预分配机制。Pool 提前创建一批处于就绪状态的沙箱容器（"暖池"），当新的创建请求到达时直接从池中分配，将沙箱启动时间从数十秒缩短到亚秒级。Pool 大小可根据历史负载动态调整。

**Protocol-First** — 协议优先设计

OpenSandbox 的核心设计理念。在编写任何实现代码之前，先以 OpenAPI 规范定义完整的 API 协议。所有 SDK、文档和服务端框架均从协议文件自动生成或严格遵循协议约定，确保多语言生态的一致性。

**RuntimeClass** — Kubernetes 运行时类

Kubernetes 内置资源，用于为不同的工作负载指定不同的容器运行时。OpenSandbox 通过 RuntimeClass 在同一集群中混合部署 runc、gVisor 和 Kata Containers 运行时，按安全等级为沙箱分配合适的隔离强度。

**Seccomp (Secure Computing Mode)** — 安全计算模式

Linux 内核的系统调用过滤机制。通过 BPF 规则定义进程允许调用的系统调用白名单，阻止危险的系统调用执行。OpenSandbox 为沙箱容器配置定制化的 Seccomp Profile，在保证正常功能的前提下最小化系统调用暴露面。

**SSE (Server-Sent Events)** — 服务端推送事件

基于 HTTP 的单向实时通信协议，服务端通过持久连接向客户端推送事件流。OpenSandbox 在代码执行和 Metrics 监控接口中使用 SSE，实现执行输出的实时流式传输，相比 WebSocket 更轻量且天然兼容 HTTP 基础设施。

**WorkloadProvider** — 工作负载提供者抽象

OpenSandbox 的内部抽象层，封装不同部署模式下的沙箱创建逻辑。Docker 模式和 Kubernetes 模式各自实现 WorkloadProvider 接口，上层 Server 代码无需关心底层运行时差异，实现了部署环境的可插拔切换。
