# 第14章 Coding Agent 场景优化

> "最好的工具是那些消失在工作流程中的工具——你感受不到它的存在，却离不开它。"
> —— Don Norman

Coding Agent 是 OpenSandbox 最核心的应用场景。当 Claude Code 需要运行一段 Python 脚本、当 Gemini CLI 需要安装一个 npm 包、当 OpenAI Codex 需要编译一个 Go 程序时，它们都需要一个安全、快速、功能完备的沙箱环境。本章分析 OpenSandbox 如何围绕 Coding Agent 的需求设计平台能力。

## 七大 Agent 集成

OpenSandbox 的 `examples/` 目录包含 22 个示例，覆盖了当前主流的 Coding Agent 平台：

| Agent | 厂商 | 示例目录 |
|-------|------|----------|
| Claude Code | Anthropic | `examples/claude-code/` |
| Gemini CLI | Google | `examples/gemini-cli/` |
| Codex CLI | OpenAI | `examples/codex-cli/` |
| Kimi CLI | Moonshot AI | `examples/kimi-cli/` |
| iFlow CLI | 自定义 HTTP | `examples/iflow-cli/` |
| LangGraph Agent | LangChain | `examples/langgraph/` |
| Google ADK Agent | Google | `examples/google-adk/` |

这些集成不是简单的 "Hello World" 演示，而是完整的端到端工作流——包括沙箱创建、Agent 配置、命令执行、文件操作和沙箱回收。每个示例都可以作为生产部署的起点。

为什么要维护如此多的集成示例？因为 Coding Agent 生态极度碎片化，每个 Agent 框架的沙箱接入方式都不同：有的通过环境变量配置，有的通过 SDK 调用，有的通过 MCP 协议。官方示例降低了用户的接入门槛，也确保了每次 API 变更时这些集成不会被意外破坏。

## Coding Agent 如何使用沙箱

一个典型的 Coding Agent 与沙箱的交互流程包含四类操作：

1. **代码执行**：Agent 生成代码片段，通过 Code Interpreter API 在沙箱中执行，获取输出结果。
2. **文件操作**：Agent 创建、读取、修改文件（如编写源代码、修改配置文件），通过 execd 的文件系统 API 完成。
3. **命令运行**：Agent 执行 shell 命令（如 `git clone`、`pip install`、`make test`），通过前台或后台命令 API 执行。
4. **包安装**：Agent 安装运行时依赖，本质上是命令执行的一个特例，但对 Egress 网络策略有特殊要求——需要允许访问包管理器的域名（如 `pypi.org`、`registry.npmjs.org`）。

这四类操作对应了 execd 组件的四个 controller：`codeinterpreting.go`、`filesystem.go`（包括 `filesystem_upload.go` 和 `filesystem_download.go`）、`command.go` 和上述命令执行逻辑。

## Code Interpreter SDK：多语言有状态执行

Code Interpreter 是 Coding Agent 最频繁使用的能力。OpenSandbox 提供了四种语言的 SDK 实现（`sdks/code-interpreter/`）：Python、JavaScript、Kotlin 和 C#，让不同技术栈的 Agent 框架都能便捷接入。

### 为什么选择 Jupyter 作为执行引擎

Code Interpreter 的核心设计决策是使用 Jupyter kernel 作为代码执行引擎（`components/execd/pkg/runtime/jupyter.go`）。这个选择基于三个关键原因：

1. **多语言支持**：Jupyter 的 kernel 架构天然支持多语言——Python（ipykernel）、Java（IJava）、Go（gophernotes）、TypeScript（tslab）、SQL 等。添加新语言只需安装对应的 kernel，无需修改 execd 代码。
2. **有状态会话**：Jupyter kernel 维护会话状态，变量在多次代码执行之间持续存在。这对 Coding Agent 至关重要——Agent 经常分步执行代码：先定义函数，再调用它；先加载数据，再分析它。无状态执行引擎无法支持这种工作模式。
3. **富输出格式**：Jupyter 原生支持图表、表格、HTML 等富输出格式，不仅仅是纯文本。当 Agent 执行数据可视化代码时，可以直接获取图表输出。

`language.go` 管理语言与 kernel 的映射关系，`context.go` 维护会话上下文，确保同一会话的多次执行共享状态。

### SSE 流式输出

代码执行的输出通过 SSE（Server-Sent Events）实时推送给客户端。`components/execd/pkg/web/controller/sse.go` 实现了 SSE 编码器，将 Jupyter kernel 的输出事件（stdout、stderr、execute_result、error、display_data）转换为 SSE 事件流。

为什么选择 SSE 而非 WebSocket？SSE 是单向的（服务器到客户端），与代码执行的数据流向完全一致。SSE 基于普通 HTTP 连接，无需协议升级，穿透 Ingress 代理和 CDN 更容易。更关键的是，SSE 内建了 event type 和 data 的语义结构，天然适合传输结构化的执行事件。

### 会话管理

Code Interpreter SDK 支持会话上下文的完整生命周期：创建（create）、列出（list）和删除（delete）。每个会话对应一个独立的 Jupyter kernel 进程，拥有独立的变量空间和执行历史。Agent 可以为不同的任务创建不同的会话——例如数据分析用一个 Python 会话，前端构建用一个 TypeScript 会话——互不干扰。

## MCP SDK：模型上下文协议集成

Model Context Protocol（MCP）是 AI 模型调用外部工具的标准协议。OpenSandbox 的 MCP SDK（`sdks/mcp/sandbox/python/`）将沙箱操作暴露为 MCP tools，使得 Claude Code、Cursor 等支持 MCP 的客户端可以直接调用沙箱能力。

MCP SDK 封装了三类工具：

1. **沙箱生命周期**：创建、查询、销毁沙箱。
2. **命令执行**：在沙箱中运行 shell 命令。
3. **文件操作**：读取、写入、搜索沙箱内的文件。

MCP 集成的价值在于 **标准化**。Agent 不需要学习 OpenSandbox 的特定 API，只需要通过 MCP 协议描述"我需要在沙箱中执行一段代码"，MCP SDK 自动处理沙箱创建、代码执行、结果返回的全部流程。这极大地简化了 Agent 与沙箱的集成复杂度。

## BatchSandbox：批量评测场景

Coding Agent 的开发过程需要大量评测（evaluation）——在多个测试用例上运行 Agent，统计通过率和质量指标。BatchSandbox CRD（`kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go`）专为此场景设计。

### 核心概念

- **Replicas**：批量创建的沙箱副本数，每个副本独立执行一个测试用例。
- **TaskTemplate**：定义每个沙箱内执行的任务——包括命令、参数、环境变量、工作目录和超时时间。
- **ShardPatches**：模板的分片补丁，允许不同副本使用不同的参数（如不同的测试数据集路径），实现数据并行。
- **TaskResourcePolicyWhenCompleted**：任务完成后的资源策略——`Retain` 保留沙箱供调试，`Release` 释放资源。

BatchSandbox 的 Status 字段追踪五种任务状态：Running、Succeeded、Failed、Pending、Unknown。kubectl 通过自定义 print columns 显示九列状态信息，运维人员一条命令即可总览整个评测任务的进展。

### 为什么需要专门的 CRD

普通沙箱是交互式的——Agent 持续连接、执行多次操作。评测场景是批处理的——创建 N 个沙箱，每个执行预定义的任务，收集结果，释放资源。批处理需要分片调度、失败重试、状态汇总等编排能力，这些逻辑嵌入专门的 CRD controller 比在 SDK 层拼凑更可靠、更高效。

## Agent-Sandbox 生命周期耦合

一个微妙但关键的设计问题是：Agent 与 Sandbox 的生命周期如何耦合？

OpenSandbox 支持两种模式。**短生命周期**：每次 Agent 任务创建一个沙箱，任务结束后销毁，适合评测和一次性执行。**长生命周期**：Agent 持有沙箱引用，跨多个对话轮次复用同一沙箱，适合交互式开发。长生命周期模式下，OSEP-0009 的自动续期机制（Ingress 代理在收到请求时发布续期意图）确保活跃使用的沙箱不会因超时被回收。

`examples/langgraph/` 展示了 LangGraph Agent 中 sandbox 生命周期与 Agent 图执行的集成模式——沙箱在图开始时创建，在图结束时销毁，图的每个节点共享同一个沙箱实例。

## 本章小结

OpenSandbox 对 Coding Agent 场景的优化体现在三个维度：**广度**（7 种主流 Agent 的原生集成和 22 个生产级示例）、**深度**（Jupyter 多语言有状态执行、SSE 流式输出、MCP 协议标准化）和**规模**（BatchSandbox 批量评测、Pool 资源池预热）。Jupyter kernel 作为执行引擎的选择是核心架构决策，它以最小的系统复杂度实现了多语言支持和有状态会话，而 MCP SDK 则通过协议标准化消除了 Agent 与沙箱之间的集成摩擦。关键源码路径：`sdks/code-interpreter/`（四语言 SDK）、`sdks/mcp/sandbox/python/`（MCP 集成）、`components/execd/pkg/runtime/jupyter.go`（Jupyter 执行引擎）、`components/execd/pkg/web/controller/codeinterpreting.go`（Code Interpreter API）、`kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go`（BatchSandbox CRD）。
