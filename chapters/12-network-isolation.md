# 第12章 网络隔离策略

> "安全不是一堵墙，而是一系列层层递进的关卡。每一层都假设前一层可能被突破。"
> —— Bruce Schneier

AI Agent 在沙箱中执行代码时，往往需要访问外部网络——下载依赖包、调用 API、抓取网页。但完全开放的网络等于没有沙箱。OpenSandbox 设计了三层网络隔离架构：Ingress 代理控制入站流量、Egress sidecar 管控出站流量、NetworkPolicy 提供声明式规则模型。本章将逐层剖析这套网络安全体系。

## 三层架构总览

OpenSandbox 的网络拓扑呈 "三明治" 结构：

```
客户端 → [Ingress Proxy] → 沙箱容器 → [Egress Sidecar] → 外部网络
                                ↑
                        [NetworkPolicy 规则]
```

Ingress 负责将外部请求安全地路由到正确的沙箱实例；Egress 拦截沙箱的出站请求，基于策略决定放行或拒绝；NetworkPolicy 是策略的声明式描述，通过 API 动态下发。三层各司其职，纵深防御。

## Ingress 代理：智能路由与沙箱发现

Ingress 组件（`components/ingress/main.go`）是一个基于 Go 实现的 HTTP/WebSocket 反向代理。它的核心职责是将客户端请求路由到正确的沙箱容器内部端口。

### 两种路由模式

Ingress 支持两种沙箱寻址方式，通过 `GatewayRouteModeConfig` 配置：

1. **Header 路由**：客户端在 HTTP 头中设置 `OpenSandbox-Ingress-To` 指定目标沙箱 ID，适合 SDK 直连场景。
2. **URI 路由**：将沙箱 ID 编码在 URL 路径中，适合浏览器直接访问的 GUI Agent 场景（如 VNC、VS Code）。

为什么需要两种模式？Header 路由对客户端来说最简洁，一个请求头搞定路由；但浏览器访问 WebSocket 或 VNC 时无法自定义请求头，此时 URI 路由就成了必需品。

### 沙箱发现机制

Ingress 通过 Kubernetes CRD Watch 机制实时感知沙箱的创建和销毁。`components/ingress/pkg/sandbox/` 目录下实现了多种 provider：`agent_sandbox_provider.go` 对接 agent-sandbox CRD，`batchsandbox_provider.go` 对接 BatchSandbox CRD。`factory.go` 根据配置的 provider 类型创建对应的实例，并设置 30 秒的重同步周期确保缓存一致性。

当请求到达时，`proxy.go` 中的 `resolveRealHost()` 查询 provider 获取沙箱的实际 IP 地址。如果沙箱不存在返回 404，沙箱未就绪返回 503，其他错误返回 502。这种精确的错误码映射帮助客户端 SDK 做出正确的重试决策。

### WebSocket 透传

GUI Agent 场景（VNC 桌面、VS Code 远程开发）依赖 WebSocket 长连接。Ingress 通过检测三个条件来识别 WebSocket 请求：HTTP 方法为 GET、`Upgrade` 头为 `websocket`、`Connection` 头为 `Upgrade`。识别后自动选择 WebSocket 专用代理，并根据 TLS 状态设置 `wss` 或 `ws` 协议。这种透明代理机制使得 GUI Agent 无需感知中间代理层的存在。

### 自动续期与健康检查

OSEP-0009 提案引入了自动续期机制：当 Ingress 收到请求时，可选地通过 Redis 发布续期意图（renew intent），通知控制面延长沙箱的生命周期。这解决了一个实际痛点——Agent 正在积极使用沙箱时，不应因为固定超时而被强制回收。`/status.ok` 端点提供健康检查，供 Kubernetes 的 readiness/liveness 探针使用。

## Egress Sidecar：出站流量的守门人

Egress sidecar（`components/egress/`）是网络隔离的核心防线，它以 sidecar 模式运行在沙箱容器的同一网络命名空间中，拦截所有出站 DNS 和 TCP 流量。

### 双模式执行

Egress 通过 `OPENSANDBOX_EGRESS_MODE` 环境变量配置执行模式：

- **dns 模式**（默认）：仅通过 DNS 代理实施策略。所有 DNS 查询被 iptables 重定向到本地 15353 端口的 DNS 代理，代理根据白名单决定是否解析。未授权域名的 DNS 查询返回 NXDOMAIN。
- **dns+nft 模式**：在 DNS 过滤基础上增加 nftables IP 层防火墙。即使应用程序绕过 DNS（硬编码 IP），nftables 规则也会阻断未授权连接。

为什么默认只用 DNS 模式？因为大部分场景下 DNS 过滤已经足够——AI Agent 执行的 `pip install`、`npm install`、`curl` 等操作都依赖 DNS 解析。dns+nft 模式需要 `CAP_NET_ADMIN` 权限和 bridge 网络模式，增加了部署复杂度，适用于对安全要求更高的场景。

### DNS 安全加固

Egress 的 DNS 代理不仅是一个白名单过滤器，还包含多项安全加固措施：

1. **系统 DNS 自动白名单**：`nameserver.go` 中的 `AllowIPsForNft()` 读取 `/etc/resolv.conf`，自动将系统 DNS 服务器 IP 加入 nftables 允许集合，确保 DNS 查询链路不被自身防火墙阻断。
2. **DoT 默认阻断**：`nft.go` 中 `BlockDoT: true` 默认阻止 DNS over TLS（端口 853），防止应用通过加密 DNS 绕过策略过滤。
3. **DoH 可配置阻断**：DNS over HTTPS 的阻断通过环境变量配置，支持按 IP/CIDR 精确设置黑名单。
4. **本地回环始终允许**：`127.0.0.1` 始终在白名单中，因为 DNS 代理本身监听在本地。

### nftables 集成

在 dns+nft 模式下，`nft.go` 中的 `setupNft()` 函数建立了 "静态策略 + 动态白名单" 的双层防火墙：

静态策略在初始化时应用，包含所有规则和系统 DNS IP。动态白名单通过回调机制实现——当 DNS 代理成功解析一个域名时，调用 `proxy.SetOnResolved()` 回调将解析得到的 IP 地址动态添加到 nftables 允许集合中。这意味着只有 DNS 白名单中的域名解析出的 IP 才会被放行，有效阻止了直接 IP 连接的绕过尝试。

## NetworkPolicy 模型

Egress 的策略模型简洁而实用：

```json
{
    "defaultAction": "deny",
    "egress": [
        {"action": "allow", "target": "pypi.org"},
        {"action": "allow", "target": "*.github.com"}
    ]
}
```

`defaultAction` 支持 `allow`（允许所有，规则为黑名单）和 `deny`（拒绝所有，规则为白名单）。Target 支持精确域名（`pypi.org`）和通配符域名（`*.example.com`），MVP 阶段不支持 IP/CIDR 规则。

为什么选择 FQDN 而非 IP？因为 AI Agent 的网络访问模式是面向服务的（`pip install` 访问 `pypi.org`，不关心其 IP 是什么），FQDN 规则更直觉、更易维护，且自动适应 CDN IP 变化。

## 策略 API 与合并语义

`policy_server.go` 提供了完整的 RESTful API：

- **GET /policy**：返回当前策略及执行模式（`deny_all`/`allow_all`/`enforcing`）。
- **POST /policy**：完整替换策略；空 body 重置为默认 deny-all。
- **PATCH /policy**：增量合并规则，保留已有规则。

PATCH 的合并语义值得关注：`mergeEgressRules()` 函数实现了 "新规则优先、同 target 去重（last-writer-wins）、域名小写归一化" 的策略。新添加的规则放在列表前端（更高优先级），相同 target 的旧规则被自动覆盖。`mergeKey()` 对域名做小写转换，确保 `PyPI.org` 和 `pypi.org` 被识别为同一目标。

所有写操作都通过 `sync.Mutex` 序列化，避免并发 PATCH 导致的丢失更新问题。Request body 限制为 1MB（`io.LimitReader(r.Body, 1<<20)`），防止恶意大负载。

## 认证机制

Egress API 使用 `OPENSANDBOX-EGRESS-AUTH` 头传递认证 token。`authorize()` 方法实现了常量时间比较（`subtle.ConstantTimeCompare`），防止时序攻击。先检查 token 长度是否一致，再进行逐字节比较。当 token 未配置时，API 无需认证——这是开发环境的便利性让步。

## Docker 网络模式的影响

Docker 运行时下，网络模式的选择直接影响 Egress 的工作方式。Host 模式下容器共享宿主网络栈，Egress sidecar 无法在独立的网络命名空间中工作；Bridge 模式下每个容器有独立的网络命名空间，Egress sidecar 可以完全控制出站流量。因此，需要 Egress 网络隔离的场景必须使用 bridge 网络模式。这个约束在 `server/src/services/docker.py` 的网络配置逻辑中得到体现。

## 本章小结

OpenSandbox 的网络隔离策略遵循 **纵深防御** 原则：Ingress 代理提供入站路由与访问控制，Egress sidecar 实施出站流量过滤，NetworkPolicy 提供声明式规则管理。三层架构中，Egress 的 DNS 代理 + nftables 双重过滤机制是安全核心，而 FQDN 规则模型、增量策略合并、常量时间认证等设计细节则体现了生产级安全系统的严谨。关键源码路径：`components/ingress/main.go` 和 `components/ingress/pkg/proxy/proxy.go`（入站代理）、`components/egress/policy_server.go`（策略 API）、`components/egress/nameserver.go`（DNS 白名单）、`components/egress/nft.go`（nftables 集成）。
