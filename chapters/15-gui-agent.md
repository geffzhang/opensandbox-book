# 第15章 GUI Agent 支持

> "图形界面是人类与计算机对话的窗口。当 AI Agent 也需要这扇窗口时，我们需要的不仅是一块屏幕，而是一套完整的视觉交互基础设施。"
> —— Alan Kay

Coding Agent 通过文本命令与沙箱交互，GUI Agent 则需要看到屏幕、操作浏览器、点击按钮。这对沙箱提出了全新的要求：图形渲染、远程显示协议、浏览器自动化和端口路由。OpenSandbox 通过四种 GUI 模式——Chromium 远程调试、VNC 桌面、Playwright 自动化和 VS Code Server——为 GUI Agent 提供了完整的视觉交互能力。

## 四种 GUI 模式

OpenSandbox 的 `examples/` 目录提供了四个 GUI 相关的示例，对应四种不同的使用场景：

| 模式 | 示例目录 | 核心技术 | 适用场景 |
|------|----------|----------|----------|
| Chrome | `examples/chrome/` | Chromium + DevTools Protocol | 浏览器自动化、网页测试 |
| Desktop | `examples/desktop/` | Xvfb + x11vnc | 桌面应用操作、截屏分析 |
| Playwright | `examples/playwright/` | Playwright + Headless Chrome | 网页抓取、端到端测试 |
| VS Code | `examples/vscode/` | code-server | 交互式远程开发 |

这四种模式并非互相排斥，而是覆盖了 GUI Agent 的不同交互层次：底层桌面访问（VNC）、浏览器级操作（Chrome/Playwright）和应用级工具（VS Code）。

## Chrome 远程调试：浏览器作为工具

Chrome 沙箱在容器内运行 Chromium 浏览器，并开启 DevTools 远程调试端口。这使得 Agent 可以通过 Chrome DevTools Protocol（CDP）与浏览器进行程序化交互：导航到指定 URL、执行 JavaScript、获取页面截图、监控网络请求。

为什么选择 DevTools Protocol 而非直接操作浏览器进程？CDP 是 Chrome 团队维护的官方协议，提供了稳定的 API 表面。通过 CDP，Agent 可以精确控制浏览器的每个行为——从页面加载到 DOM 操作到网络拦截——而不需要模拟鼠标点击和键盘输入。这种精确控制对于网页测试和数据提取任务至关重要。

Chrome 沙箱的网络配置需要特别注意：远程调试端口需要通过 Ingress 代理暴露给外部 Agent。`getEndpoint(port)` API 返回沙箱内特定端口的可达地址，Agent 通过此地址建立 CDP 连接。Ingress 的 WebSocket 透传能力在此发挥关键作用，因为 CDP 基于 WebSocket 通信。

## VNC 桌面：完整的视觉环境

VNC 桌面模式（`examples/desktop/`）提供了最底层的 GUI 能力——一个完整的 Linux 桌面环境。技术栈由两个组件构成：

### Xvfb：虚拟帧缓冲

Xvfb（X Virtual Framebuffer）是一个运行在内存中的 X11 显示服务器，它模拟了一个物理显示器，但所有渲染结果只存在于内存帧缓冲中。沙箱内的桌面环境、窗口管理器、GUI 应用程序都连接到这个虚拟显示器。

为什么用 Xvfb 而不是真实的 GPU 渲染？因为沙箱运行在容器中，通常没有 GPU 设备。Xvfb 通过纯 CPU 渲染提供 X11 兼容的显示服务，任何依赖 X11 的 Linux GUI 应用都可以正常运行。性能足以满足 GUI Agent 的截屏和操作需求——Agent 不需要 60fps 的流畅画面，只需要能获取当前屏幕状态的截图。

### x11vnc：远程显示协议

x11vnc 连接到 Xvfb 的虚拟显示器，通过 VNC 协议将屏幕内容传输给远程客户端。VNC 客户端（或 noVNC Web 客户端）可以查看桌面画面、发送鼠标和键盘事件。

为什么选择 VNC 而非 RDP 或其他远程桌面协议？VNC 协议简单、开源、跨平台，实现成本最低。x11vnc 可以直接附加到已有的 X11 显示器上，不需要像 RDP 那样运行完整的远程桌面服务。更重要的是，VNC 的帧缓冲模型与 GUI Agent 的工作模式高度匹配——Agent 需要的是 "获取当前屏幕截图" 和 "在坐标 (x, y) 点击"，VNC 正好提供这两个原语。

## Playwright 自动化：结构化浏览器操作

Playwright 模式（`examples/playwright/`）介于底层 VNC 和高层 Chrome DevTools 之间，提供了跨浏览器的自动化框架。Playwright 在沙箱内运行 headless 浏览器，通过其专有协议进行自动化控制。

与直接使用 CDP 相比，Playwright 的优势在于：

1. **高层 API**：提供 `page.click()`、`page.fill()`、`page.waitForSelector()` 等语义化 API，比 CDP 的低层消息更易于 Agent 使用。
2. **自动等待**：Playwright 内建了智能等待机制，自动处理页面加载、元素可见性等异步问题，Agent 无需手动管理定时器。
3. **跨浏览器**：同一套 API 支持 Chromium、Firefox 和 WebKit，适用于需要跨浏览器测试的场景。

Playwright 沙箱适合网页抓取（web scraping）和端到端测试任务。Agent 可以导航到目标网站、提取结构化数据、验证 UI 行为，所有操作都在隔离的沙箱环境中完成，不会暴露 Agent 的 IP 地址或 cookie。

## VS Code Server：开发者级工具

VS Code Server 模式（`examples/vscode/`）在沙箱内运行 code-server——VS Code 的服务端版本。通过 Ingress 代理的 HTTP/WebSocket 路由，开发者（或 Agent）可以在浏览器中打开一个完整的 VS Code IDE，直接编辑沙箱内的文件、运行终端命令、安装扩展。

这种模式的独特价值在于 **人机协作**。Agent 在沙箱中生成代码后，开发者可以通过 VS Code 界面审查代码、手动调试、添加修改。VS Code 的 Language Server Protocol（LSP）提供了代码补全、错误诊断、重构等 IDE 能力，让人工审查过程更高效。

## Ingress 代理的 GUI 支撑角色

四种 GUI 模式都依赖 Ingress 代理将外部请求路由到沙箱内部端口。Ingress 在 GUI 场景中承担了三个关键角色：

### 端口路由

沙箱内可能同时运行多个服务——VNC 在 5900 端口、Chrome DevTools 在 9222 端口、VS Code 在 8080 端口。Ingress 通过 `getEndpoint(port)` API 为每个端口生成唯一的外部可达地址。Agent 或用户通过这个地址访问沙箱内的特定服务。

### WebSocket 长连接

VNC（通过 noVNC）、Chrome DevTools、VS Code 都依赖 WebSocket 长连接。Ingress 的 WebSocket 透传能力（在 `components/ingress/pkg/proxy/proxy.go` 中实现）确保这些长连接不被中间代理层打断。协议自动识别（检测 Upgrade 头）和方案自动选择（wss/ws）让 GUI 客户端无需感知代理层的存在。

### URI 路由模式

浏览器直接访问 VNC Web 客户端或 VS Code 界面时，无法设置自定义 HTTP 头。此时 Ingress 的 URI 路由模式（将沙箱 ID 编码在 URL 路径中）就成了唯一的寻址方式。这解释了为什么 Ingress 要支持两种路由模式——Header 路由服务于 SDK 编程接口，URI 路由服务于浏览器直接访问。

## 网络端点管理

GUI Agent 场景的网络端点管理比 Coding Agent 更复杂。Coding Agent 只需要访问 execd 的 API 端口；GUI Agent 需要访问沙箱内的多个服务端口，每个端口对应不同的 GUI 协议。

SDK 提供的 `getEndpoint(port)` 方法封装了端点发现逻辑：查询沙箱的网络地址，结合 Ingress 的路由配置，返回一个外部可达的 URL。在 Kubernetes 部署中，这个 URL 经过 Ingress 代理；在 Docker 本地部署中，可能是宿主机的映射端口。这种抽象让 Agent 代码在不同部署模式下保持一致。

## 使用场景分析

四种 GUI 模式适用于不同的 Agent 任务：

- **网页测试**：Chrome + DevTools 或 Playwright，Agent 导航到目标页面、验证 UI 元素、检查网络请求。
- **UI 自动化**：VNC Desktop，Agent 操作桌面应用——填写表单、点击按钮、读取对话框文本。
- **视觉验证**：VNC Desktop 或 Chrome，Agent 截取屏幕截图并通过视觉大模型分析 UI 布局和内容。
- **交互式开发**：VS Code Server，开发者通过浏览器 IDE 审查 Agent 生成的代码、协同调试。

选择哪种模式取决于 Agent 的能力层次：如果 Agent 能理解 DOM 结构，Chrome/Playwright 更高效；如果 Agent 只能处理像素级输入（截图），VNC 是唯一选择；如果需要人工介入，VS Code 提供最佳体验。

## 本章小结

GUI Agent 支持是 OpenSandbox 区别于纯 Code Interpreter 平台的关键能力。通过 Xvfb + x11vnc 的 VNC 桌面、Chrome DevTools Protocol 的浏览器控制、Playwright 的结构化自动化和 code-server 的远程 IDE，OpenSandbox 覆盖了从像素级桌面操作到语义化浏览器控制的完整 GUI 交互谱系。Ingress 代理在其中扮演了不可或缺的角色——通过 WebSocket 透传、URI 路由和端口管理，将沙箱内的 GUI 服务安全地暴露给外部 Agent。关键源码路径：`examples/chrome/`（Chrome 远程调试）、`examples/desktop/`（VNC 桌面）、`examples/playwright/`（浏览器自动化）、`examples/vscode/`（VS Code Server）、`components/ingress/pkg/proxy/proxy.go`（WebSocket 代理和路由逻辑）。
