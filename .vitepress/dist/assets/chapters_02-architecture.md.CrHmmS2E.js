import{_ as s,o as a,c as n,ag as p}from"./chunks/framework.BZohXCq9.js";const u=JSON.parse('{"title":"第2章 Repo 结构与平台架构","description":"","frontmatter":{},"headers":[],"relativePath":"chapters/02-architecture.md","filePath":"chapters/02-architecture.md"}'),o={name:"chapters/02-architecture.md"};function c(r,e,l,t,i,d){return a(),n("div",null,[...e[0]||(e[0]=[p(`<h1 id="第2章-repo-结构与平台架构" tabindex="-1">第2章 Repo 结构与平台架构 <a class="header-anchor" href="#第2章-repo-结构与平台架构" aria-label="Permalink to &quot;第2章 Repo 结构与平台架构&quot;">​</a></h1><blockquote><p>&quot;The structure of a codebase is the first design document — before reading any code, the directory tree tells you what the authors valued.&quot; — 改编自 John Ousterhout</p></blockquote><h2 id="顶层目录结构" tabindex="-1">顶层目录结构 <a class="header-anchor" href="#顶层目录结构" aria-label="Permalink to &quot;顶层目录结构&quot;">​</a></h2><p>打开 OpenSandbox 的仓库，你会看到一个清晰的顶层目录布局：</p><div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>OpenSandbox/</span></span>
<span class="line"><span>├── .github/          # CI/CD 工作流</span></span>
<span class="line"><span>├── cli/              # 命令行工具</span></span>
<span class="line"><span>├── components/       # 核心组件（Go 语言）</span></span>
<span class="line"><span>│   ├── execd/        # 沙盒内执行守护进程</span></span>
<span class="line"><span>│   ├── ingress/      # 入口流量代理</span></span>
<span class="line"><span>│   ├── egress/       # 出口流量控制</span></span>
<span class="line"><span>│   └── internal/     # 共享内部库</span></span>
<span class="line"><span>├── docs/             # 架构与设计文档</span></span>
<span class="line"><span>├── examples/         # 21 个集成示例</span></span>
<span class="line"><span>├── kubernetes/       # K8s Operator + CRD + Helm Chart</span></span>
<span class="line"><span>├── oseps/            # 10 个增强提案（Enhancement Proposals）</span></span>
<span class="line"><span>├── sandboxes/        # 沙盒镜像定义（code-interpreter）</span></span>
<span class="line"><span>├── scripts/          # 开发与运维脚本</span></span>
<span class="line"><span>├── sdks/             # 多语言 SDK</span></span>
<span class="line"><span>├── server/           # Python FastAPI 生命周期服务器</span></span>
<span class="line"><span>├── specs/            # 3 份 OpenAPI 规范文件</span></span>
<span class="line"><span>└── tests/            # 跨组件集成测试</span></span></code></pre></div><p>这个结构揭示了团队的几个关键设计决策。首先，<strong>协议与实现分离</strong> — <code>specs/</code> 目录独立于任何实现代码存在，三份 OpenAPI 文件（<code>sandbox-lifecycle.yml</code>、<code>execd-api.yaml</code>、<code>egress-api.yaml</code>）是整个系统的契约来源。其次，<strong>多语言共存</strong> — <code>components/</code> 使用 Go 编写高性能守护进程，<code>server/</code> 使用 Python FastAPI 实现业务逻辑，<code>sdks/</code> 则包含 Python、JavaScript、Kotlin、C# 四种语言的客户端库。</p><h2 id="sdk-的三层结构" tabindex="-1">SDK 的三层结构 <a class="header-anchor" href="#sdk-的三层结构" aria-label="Permalink to &quot;SDK 的三层结构&quot;">​</a></h2><p><code>sdks/</code> 目录的组织方式值得关注：</p><div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>sdks/</span></span>
<span class="line"><span>├── sandbox/              # 基础沙盒 SDK</span></span>
<span class="line"><span>│   ├── python/</span></span>
<span class="line"><span>│   ├── javascript/</span></span>
<span class="line"><span>│   ├── kotlin/</span></span>
<span class="line"><span>│   └── csharp/</span></span>
<span class="line"><span>├── code-interpreter/     # 代码解释器高级 SDK</span></span>
<span class="line"><span>│   ├── python/</span></span>
<span class="line"><span>│   ├── javascript/</span></span>
<span class="line"><span>│   ├── kotlin/</span></span>
<span class="line"><span>│   └── csharp/</span></span>
<span class="line"><span>└── mcp/                  # MCP 协议集成 SDK</span></span>
<span class="line"><span>    ├── python/</span></span>
<span class="line"><span>    └── javascript/</span></span></code></pre></div><p>为什么要分三层？这是因为不同用户有不同的抽象需求。基础 SDK（<code>sandbox/</code>）提供沙盒生命周期和原始执行 API 的封装，适合需要完全控制的场景。code-interpreter SDK 在此基础上封装了代码上下文管理和执行结果解析，适合 AI 代码执行场景。MCP SDK 则直接暴露 Model Context Protocol 接口，让沙盒能作为 AI 工具被大语言模型直接调用。</p><h2 id="server-内部结构" tabindex="-1">Server 内部结构 <a class="header-anchor" href="#server-内部结构" aria-label="Permalink to &quot;Server 内部结构&quot;">​</a></h2><p><code>server/</code> 是整个系统的核心，采用典型的分层架构：</p><div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>server/src/</span></span>
<span class="line"><span>├── api/</span></span>
<span class="line"><span>│   ├── lifecycle.py      # 10 个路由定义</span></span>
<span class="line"><span>│   └── schema.py         # Pydantic 数据模型</span></span>
<span class="line"><span>├── middleware/</span></span>
<span class="line"><span>│   ├── auth.py           # API Key 认证中间件</span></span>
<span class="line"><span>│   └── request_id.py     # 请求追踪中间件</span></span>
<span class="line"><span>└── services/</span></span>
<span class="line"><span>    ├── factory.py         # 运行时工厂</span></span>
<span class="line"><span>    ├── sandbox_service.py # 抽象基类</span></span>
<span class="line"><span>    ├── docker.py          # Docker 后端（约 2132 行）</span></span>
<span class="line"><span>    └── k8s/               # Kubernetes 后端（15 个文件）</span></span>
<span class="line"><span>        ├── client.py</span></span>
<span class="line"><span>        ├── informer.py</span></span>
<span class="line"><span>        ├── kubernetes_service.py</span></span>
<span class="line"><span>        ├── batchsandbox_provider.py</span></span>
<span class="line"><span>        ├── agent_sandbox_provider.py</span></span>
<span class="line"><span>        ├── workload_provider.py</span></span>
<span class="line"><span>        ├── provider_factory.py</span></span>
<span class="line"><span>        ├── rate_limiter.py</span></span>
<span class="line"><span>        ├── volume_helper.py</span></span>
<span class="line"><span>        ├── egress_helper.py</span></span>
<span class="line"><span>        ├── image_pull_secret_helper.py</span></span>
<span class="line"><span>        ├── template_manager.py</span></span>
<span class="line"><span>        └── ...</span></span></code></pre></div><p>这里有一个有趣的不对称：Docker 后端是单文件实现（<code>docker.py</code> 约 2132 行），而 Kubernetes 后端拆分为 15 个文件。这并非偶然。Docker API 相对简单，一个类就能封装完整的生命周期；而 Kubernetes 涉及 CRD 管理、Informer 缓存、速率限制、多种 Workload 类型等复杂抽象，自然需要更细粒度的模块划分。</p><p>Kubernetes 后端中每个文件都有明确的职责：<code>client.py</code> 封装 API 访问和缓存策略，<code>informer.py</code> 实现 List-Watch 模式，<code>rate_limiter.py</code> 提供令牌桶限流，<code>volume_helper.py</code> 和 <code>egress_helper.py</code> 分别处理存储和网络配置，<code>template_manager.py</code> 管理 Pod 模板渲染。这种按关注点分离的方式使得每个文件都可以独立理解和测试。</p><h2 id="四层架构" tabindex="-1">四层架构 <a class="header-anchor" href="#四层架构" aria-label="Permalink to &quot;四层架构&quot;">​</a></h2><p>从请求的流转角度看，OpenSandbox 是一个清晰的四层架构：</p><div class="language- vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang"></span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>SDK 层          →  Lifecycle Server 层  →  运行时后端层       →  容器层</span></span>
<span class="line"><span>(Python/JS/     (FastAPI, lifecycle.py)  (Docker/K8s Service)  (execd 守护进程)</span></span>
<span class="line"><span> Kotlin/C#)</span></span></code></pre></div><p><strong>SDK 层</strong> 负责将用户的高级操作（如&quot;执行 Python 代码&quot;）转换为 HTTP 请求。请求首先到达 <strong>Lifecycle Server 层</strong>，<code>api/lifecycle.py</code> 中的 10 个路由处理生命周期操作，通过 <code>middleware/auth.py</code> 完成 API Key 认证。路由层是纯粹的 HTTP 适配器，不包含业务逻辑。</p><p>真正的业务逻辑在 <strong>运行时后端层</strong>。<code>services/factory.py</code> 中的 <code>create_sandbox_service()</code> 工厂函数根据配置选择 Docker 或 Kubernetes 实现。两者都实现了 <code>SandboxService</code> 抽象基类（定义在 <code>services/sandbox_service.py</code>），保证了统一的接口契约。</p><p><strong>容器层</strong> 是 execd 守护进程运行的地方。无论底层是 Docker 容器还是 Kubernetes Pod，execd 都提供相同的执行 API — 代码运行、命令执行、文件操作和系统监控。</p><h2 id="工厂模式与运行时选择" tabindex="-1">工厂模式与运行时选择 <a class="header-anchor" href="#工厂模式与运行时选择" aria-label="Permalink to &quot;工厂模式与运行时选择&quot;">​</a></h2><p><code>factory.py</code> 的实现遵循经典的工厂模式：维护一个字典映射运行时类型字符串（<code>&quot;docker&quot;</code> 或 <code>&quot;kubernetes&quot;</code>）到对应的 Service 类，根据配置实例化。如果传入不支持的类型，则抛出 <code>ValueError</code> 并列出所有可用选项。</p><p>这个设计使得未来添加新的运行时后端（例如 Firecracker 直接集成）只需要实现 <code>SandboxService</code> 接口并在工厂中注册即可，无需修改任何上层代码。</p><p>值得一提的是，工厂函数还接受一个可选的 override 参数，允许在运行时动态切换后端类型。这为测试场景提供了便利 — 集成测试可以在同一进程中切换 Docker 和 Kubernetes 后端，验证两者的行为一致性。</p><h2 id="kubernetes-后端的-workloadprovider-抽象" tabindex="-1">Kubernetes 后端的 WorkloadProvider 抽象 <a class="header-anchor" href="#kubernetes-后端的-workloadprovider-抽象" aria-label="Permalink to &quot;Kubernetes 后端的 WorkloadProvider 抽象&quot;">​</a></h2><p>Kubernetes 后端进一步引入了 <code>WorkloadProvider</code> 抽象层（<code>k8s/workload_provider.py</code>）。这是因为 Kubernetes 中&quot;沙盒&quot;可以映射到不同的资源类型 — <code>BatchSandbox</code> CRD（通过 <code>batchsandbox_provider.py</code>）用于批量沙盒管理，<code>AgentSandbox</code>（通过 <code>agent_sandbox_provider.py</code>）支持 <code>kubernetes-sigs/agent-sandbox</code> 社区标准。</p><p><code>provider_factory.py</code> 负责根据配置选择具体的 Provider 实现。这种双层工厂模式（Service 工厂 + Provider 工厂）看似复杂，但实际上反映了 Kubernetes 生态的现实：社区有多种沙盒编排方案，OpenSandbox 需要灵活适配。</p><h2 id="components-go-语言的高性能组件" tabindex="-1">components：Go 语言的高性能组件 <a class="header-anchor" href="#components-go-语言的高性能组件" aria-label="Permalink to &quot;components：Go 语言的高性能组件&quot;">​</a></h2><p><code>components/</code> 目录使用 Go 语言实现了四个核心组件，它们运行在容器内部或作为 sidecar 部署。为什么选择 Go 而非 Python？因为这些组件对性能和资源占用有严格要求 — execd 守护进程需要常驻容器内存，Go 的静态编译产物不依赖运行时环境，单个二进制文件即可注入任意容器。</p><ul><li><code>execd/</code> — 沙盒内执行守护进程，暴露代码执行、命令运行和文件操作 API，监听端口 44772</li><li><code>ingress/</code> — 入口流量代理，为每个沙盒提供可寻址的外部端点</li><li><code>egress/</code> — 出口流量控制代理，基于 FQDN 白名单过滤出站请求</li><li><code>internal/</code> — 共享内部库，被其他三个组件引用</li></ul><h2 id="osep-增强提案" tabindex="-1">OSEP 增强提案 <a class="header-anchor" href="#osep-增强提案" aria-label="Permalink to &quot;OSEP 增强提案&quot;">​</a></h2><p><code>oseps/</code> 目录包含 10 个 OpenSandbox Enhancement Proposals，这是项目治理的重要组成部分。从 OSEP-0001（FQDN 出口控制，已实现）到 OSEP-0010（OpenTelemetry 可观测性集成），这些提案记录了每个重大功能的动机、设计方案和实施状态。</p><p>部分值得关注的提案包括：OSEP-0002 引入了对 <code>kubernetes-sigs/agent-sandbox</code> 社区标准的支持，OSEP-0004 实现了可插拔的安全容器运行时，OSEP-0005 设计了客户端连接池以降低沙盒创建延迟，OSEP-0008 则规划了基于 rootfs 快照的暂停/恢复机制（目前仍处于草案阶段）。这种透明的决策过程对于开源项目尤为重要。</p><h2 id="本章小结" tabindex="-1">本章小结 <a class="header-anchor" href="#本章小结" aria-label="Permalink to &quot;本章小结&quot;">​</a></h2><p>OpenSandbox 的仓库结构体现了协议与实现分离、多语言共存和分层架构三大原则。核心请求路径经过四层：SDK → Lifecycle Server（FastAPI）→ 运行时后端（Docker/K8s）→ 容器（execd）。工厂模式和 WorkloadProvider 抽象使得系统能够灵活适配不同的运行时和编排方案。在下一章中，我们将深入探讨驱动这一切的统一 API 设计。</p>`,36)])])}const b=s(o,[["render",c]]);export{u as __pageData,b as default};
