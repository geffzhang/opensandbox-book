# 第6章 Python SDK 设计

> "好的 API 应该像一篇优美的散文——读起来自然流畅，写起来心中有数。" —— Joshua Bloch

## 6.1 包结构总览

OpenSandbox 的 Python SDK 位于 `sdks/sandbox/python/src/opensandbox/`，是用户与沙箱系统交互的主要入口。整个包的目录结构经过精心设计，职责划分清晰：

```
opensandbox/
├── adapters/        # HTTP 适配层（基于 httpx）
├── api/             # 底层 API 调用封装
├── config/          # 连接配置管理
├── exceptions/      # 自定义异常体系
├── models/          # 数据模型定义
├── services/        # 高层服务抽象（Files, Commands, Metrics 等）
├── sync/            # 同步 API 镜像实现
│   ├── adapters/
│   ├── services/
│   ├── manager.py
│   └── sandbox.py
├── constants.py     # 常量定义
├── manager.py       # SandboxManager 管理器
├── sandbox.py       # Sandbox 核心类
└── py.typed         # PEP 561 类型标记
```

为什么采用这样的分层结构？核心原因在于**关注点分离**。`adapters/` 层将 HTTP 传输细节（httpx 异步客户端、连接池、超时控制）与业务逻辑完全隔离，未来若要替换为其他 HTTP 库，只需修改适配层。`services/` 层则通过 Protocol 协议定义了六大服务接口：Commands、Filesystem、Health、Metrics、Egress 和 Sandboxes，让上层代码面向接口编程而非绑定具体实现。

`exceptions/` 目录定义了 SDK 自己的异常层次结构，将底层 HTTP 错误（网络超时、连接拒绝）和业务错误（沙箱不存在、状态冲突）统一包装为 `SandboxException` 及其子类。这样做的好处是用户只需捕获一种异常类型，就能处理所有 SDK 相关的错误情况。`config/` 目录管理连接配置——lifecycle server 的地址、认证令牌、超时参数等，支持从环境变量或配置对象中读取，为不同部署环境（本地开发、测试、生产）提供灵活的配置方式。`models/` 目录则包含所有请求和响应的数据模型定义，利用 Python 类型注解和 Pydantic 风格的验证确保数据的完整性和类型安全。

`py.typed` 文件虽然内容为空，却意义重大——它是 PEP 561 规定的类型标记文件，告诉 mypy 等类型检查工具"这个包提供了内联的类型注解"。对于 SDK 库来说，良好的类型支持直接影响开发者在 IDE 中的自动补全和错误提示体验。

## 6.2 Sandbox 核心类

`sandbox.py` 是整个 SDK 的灵魂所在。Sandbox 类采用**静态工厂方法**模式，提供三种实例化路径：

- `Sandbox.create()` — 创建全新沙箱，传入镜像、环境变量、网络策略、资源限制等参数
- `Sandbox.connect()` — 通过 sandbox_id 连接到已有的运行中沙箱
- `Sandbox.resume()` — 恢复一个已暂停的沙箱

为什么不用普通构造函数？因为沙箱的创建涉及异步网络调用——需要向 lifecycle server 发送 POST 请求，轮询等待容器就绪。Python 的 `__init__` 方法不支持 `await`，而静态工厂方法 `create()` 作为 `async` 函数可以优雅地处理这一流程。

Sandbox 实例通过**属性代理**提供服务访问：

```python
sandbox.files      # → Filesystem 服务：文件的增删改查、上传下载
sandbox.commands    # → Commands 服务：命令执行与后台任务
sandbox.metrics     # → Metrics 服务：CPU、内存等资源监控
```

这种设计让用户代码读起来像自然语言：`sandbox.files.write("/tmp/data.txt", content)` 就是"在沙箱的文件系统中写入一个文件"。

## 6.3 生命周期管理

Sandbox 类提供了完整的生命周期操作方法：

- **暂停与终止**：`pause()` 冻结沙箱状态，`kill()` 永久终止远程实例（不可逆），`close()` 释放本地连接资源
- **续期**：`renew(timeout)` 延长沙箱过期时间，底层使用 UTC 时区感知的 datetime 计算
- **状态查询**：`get_info()` 获取完整状态信息，`get_metrics()` 查看资源用量，`is_healthy()` 执行健康检查，`check_ready()` 以轮询方式等待沙箱就绪

值得注意的是 `create()` 方法内部的**自动清理机制**：如果沙箱创建过程中出现异常（例如超时或镜像拉取失败），SDK 会自动尝试 kill 已创建的远程实例，避免留下僵尸容器。这种防御性设计体现了对生产环境稳定性的重视。

## 6.4 网络策略控制

网络相关操作通过两个方法暴露：

- `get_egress_policy()` — 查询当前出口流量策略
- `patch_egress_rules()` — 增量更新出口规则

结合 `get_endpoint()` 和 `get_endpoint_url()`，用户可以获取沙箱对外暴露的服务地址。这种设计将网络策略管理与沙箱访问地址解析统一在 Sandbox 对象上，避免了用户需要单独管理网络配置的复杂性。

## 6.5 异步上下文管理器

SDK 支持 Python 的 `async with` 语法，实现自动资源清理：

```python
async with await Sandbox.create(image="python:3.11") as sandbox:
    result = await sandbox.commands.run("echo hello")
    # 退出 with 块时自动调用 close() 释放连接资源
```

这里有一个微妙的设计点：`await Sandbox.create(...)` 返回的 Sandbox 对象实现了 `__aenter__` 和 `__aexit__` 协议。`__aexit__` 中调用的是 `close()` 而非 `kill()`——这意味着退出上下文仅释放本地连接，沙箱实例依然存活直到超时过期。如果用户需要立即销毁沙箱，应在 with 块内显式调用 `kill()`。

## 6.6 SandboxManager：批量管理

当需要管理多个沙箱时，SandboxManager 提供了**行政层面的操作**：

- `list_sandbox_infos(filter)` — 列出沙箱，支持过滤条件
- `get_sandbox_info(sandbox_id)` — 查询特定沙箱详情
- `kill_sandbox()` / `pause_sandbox()` / `resume_sandbox()` — 批量生命周期操作
- `renew_sandbox()` — 为指定沙箱续期

SandboxManager 同样采用工厂方法 `create()` 实例化，并支持 async 上下文管理器。它与 Sandbox 类的职责边界非常明确：Sandbox 负责"单个沙箱的一切操作"，SandboxManager 负责"跨沙箱的发现与管理"。

为什么需要 SandboxManager 而不是把管理功能放在 Sandbox 类上？因为列出所有沙箱、按条件过滤、批量操作等功能在语义上不属于任何一个沙箱实例。如果将 `list_sandbox_infos()` 做成 Sandbox 的静态方法，会模糊类的职责边界。SandboxManager 的引入遵循了**单一职责原则**——每个类只做一件事，并且做好。SandboxManager 内部使用了完善的日志记录，每个操作都会输出结构化日志，方便在分布式环境中追踪问题。异常处理上，它保留了底层 SandboxException 的原始信息，不做静默吞没，确保调用方能获得充分的错误上下文。

## 6.7 双 API 模式：异步与同步

`sync/` 目录下完整镜像了异步 API 的同步版本：

| 异步 API | 同步 API |
|----------|---------|
| `Sandbox` | `SandboxSync` |
| `SandboxManager` | `SandboxManagerSync` |

同步版本包装了异步实现，内部通过事件循环桥接。这种设计让 SDK 同时服务于两类用户：追求高并发的异步应用（如 FastAPI 后端服务中并行创建多个沙箱），以及脚本化场景下更简单的同步调用（如 Jupyter Notebook 中的交互式探索、CLI 工具中的单次操作）。

`sync/` 目录下的镜像结构完整且对称——不仅有 `sandbox.py` 和 `manager.py` 对应异步版本的 Sandbox 和 SandboxManager，还有独立的 `adapters/` 和 `services/` 子目录。这意味着同步版本并非简单地在异步方法外面套一层 `asyncio.run()`，而是拥有完整的适配器和服务层实现，能够正确处理同步场景下的连接管理、超时控制和错误传播。这种"完整镜像"的代价是代码量接近翻倍，但换来的是两套 API 在行为一致性上的保证。

## 6.8 扩展 SDK 生态

在核心 Sandbox SDK 之上，OpenSandbox 还提供了两个专用 SDK：

**Code Interpreter SDK**（`sdks/code-interpreter/python/`）封装了有状态的多语言代码执行能力，通过 Jupyter kernel 实现 Python、Java、Go、TypeScript 等语言的交互式执行，支持会话上下文保持。

**MCP SDK**（`sdks/mcp/sandbox/python/`）实现了 Model Context Protocol 集成，让 AI 模型能够通过标准化协议直接调用沙箱操作——创建沙箱、执行代码、读写文件等，为 AI Agent 场景提供了开箱即用的工具集。

## 本章小结

Python SDK 的设计哲学可以归纳为三个关键词：**分层隔离**（adapters → services → Sandbox）、**双模并行**（async + sync）、**接口优先**（Protocol 协议定义服务契约）。静态工厂方法解决了异步构造的难题，上下文管理器确保了资源安全，而 SandboxManager 则为规模化管理提供了便捷入口。这套设计在保持 API 简洁性的同时，为不同使用场景提供了足够的灵活性。
