# 第9章 代码执行引擎（多语言支持）

> "Talk is cheap. Show me the code." —— Linus Torvalds

## 9.1 execd 守护进程概览

代码执行是沙箱系统的核心价值所在。OpenSandbox 将这一能力封装在 execd 守护进程中，源码位于 `components/execd/`。execd 使用 Go 语言编写，入口文件 `components/execd/main.go` 的启动流程简洁明了：显示版本信息 → 初始化命令行参数 → 配置日志 → 创建代码执行控制器 → 启动带有 access token 认证的 HTTP 服务。

选择 Go 的原因与沙箱场景高度契合：execd 需要高效地管理大量子进程，Go 的 goroutine 天然适合并发 I/O 和进程管理；单二进制部署简化了向容器内注入 execd 的流程；而 `go.uber.org/automaxprocs` 的引入确保了在容器 cgroup 限制下正确检测可用 CPU 数量，避免 goroutine 调度器过度分配线程。

execd 内部使用 Gin Web 框架提供 HTTP API，通过 `pkg/web/controller/` 下的控制器处理不同类型的请求：`command.go`（命令执行）、`codeinterpreting.go`（代码解释执行）、`filesystem.go`（文件操作）、`metric.go`（资源指标）。

## 9.2 命令执行：进程管理的艺术

命令执行的核心逻辑位于 `components/execd/pkg/runtime/command.go`，分为前台执行和后台执行两种模式。

### 前台命令执行

`runCommand()` 函数实现了沙箱内的阻塞式命令执行，其中蕴含了多个精心的设计决策：

**Shell 选择**：`getShell()` 函数优先使用 bash，若不存在则退回 sh。这个看似简单的逻辑是为了兼容 Alpine 等精简镜像——它们默认不包含 bash。

**进程组隔离**：通过 `SysProcAttr{Setpgid: true}` 将子进程放入独立的进程组。为什么不让子进程继承 execd 的进程组？因为一旦用户命令产生了子进程树（例如 `npm start` 启动多个 worker），信号需要能广播到整个进程树。独立进程组允许通过 `kill(-pgid, signal)` 向整组发送信号。

**信号转发**：execd 将自身收到的大部分信号转发给子进程，但**显式排除了 SIGCHLD 和 SIGURG**。排除 SIGCHLD 的原因是它是子进程退出时内核自动发给父进程的通知信号，转发给子进程毫无意义。排除 SIGURG 则是因为 Go 运行时内部使用 SIGURG 实现 goroutine 抢占式调度（自 Go 1.14 起），转发此信号会干扰子进程的正常运行。

**用户身份切换**：`buildCredential()` 函数根据 UID/GID 构建系统调用凭证，支持以特定用户身份执行命令。它不仅设置主 UID/GID，还通过操作系统用户查找加载附属组，确保文件权限检查的完整性。

**输出流处理**：stdout 和 stderr 分别重定向到临时文件描述符，由并发 goroutine 进行 tail 读取。使用 `sync.WaitGroup` 确保两个输出流都完成刷写后才返回结果。这种设计保证了即使命令产生大量输出，也不会因为管道缓冲区满而导致死锁——这是子进程管理中的经典陷阱。

**退出码保留**：函数严格区分"命令执行失败"和"命令返回非零退出码"。前者是系统错误（如 shell 不存在），后者是正常的业务语义（如 `grep` 未匹配到内容返回 1）。

### 后台命令执行

`runBackgroundCommand()` 实现了非阻塞式命令执行，设计上做了几个关键的差异化处理：

- **合并输出**：stdout 和 stderr 合并到同一管道，因为后台命令通常不需要区分两者
- **stdin 重定向**：将 stdin 指向 `/dev/null`，防止后台命令试图读取交互式输入而阻塞
- **PID 追踪**：返回进程 PID 供后续管理（查询状态、发送信号）
- **进程组 kill**：取消时通过 SIGKILL 发送给整个进程组（`-pgid`），确保子进程树被完全清理

## 9.3 Jupyter 内核集成

多语言代码执行的核心是 Jupyter kernel 集成，实现在 `components/execd/pkg/runtime/jupyter.go`。

### 执行流程

`runJupyter()` → `runJupyterCode()` 的调用链实现了完整的 Jupyter 执行流程：

1. **验证配置**：检查 Jupyter 是否启用，语言是否支持
2. **获取或创建会话**：从 `jupyterClientMap`（并发安全的 map）中查找已有 kernel，若不存在则通过 `searchKernel()` 查找匹配语言的 kernel spec 并创建新会话
3. **加锁执行**：获取 kernel 级别的 mutex 锁，防止同一 kernel 上并发执行代码——Jupyter kernel 是单线程的，并发请求会导致状态混乱
4. **WebSocket 通信**：通过 WebSocket 连接向 kernel 发送 `execute_request` 消息
5. **流式结果接收**：通过 channel 接收执行结果，包括 stdout、stderr、execute_result 和 error 四种消息类型
6. **SSE 推送**：将结果以 Server-Sent Events 格式流式推送给客户端

为什么使用 mutex 锁而非队列？因为 Jupyter kernel 的执行是有序的——每个 execute_request 必须等待前一个完成。mutex 锁简单直接地保证了这一语义，而队列会引入额外的复杂性且没有本质收益。

### 上下文取消

当客户端断开连接或超时时，Go 的 context 取消机制触发，`runJupyterCode()` 检测到取消后立即向 kernel 发送中断请求（interrupt），类似于在 Jupyter Notebook 中按下"中断内核"按钮。这确保了长时间运行的代码（如无限循环）不会永久占用 kernel 资源。

## 9.4 会话管理与上下文

`components/execd/pkg/runtime/context.go` 实现了会话生命周期管理，这是有状态代码执行的基础：

- **CreateContext**：创建新的 Jupyter 会话，包含重试逻辑（kernel 启动可能需要时间），存储 kernel 映射，配置工作目录，返回会话 ID
- **DeleteContext**：删除会话并执行清理（`deleteSessionAndCleanup`）
- **GetContext**：根据会话 ID 查询上下文元数据（语言、ID）
- **ListContext**：按语言过滤列出所有上下文，支持查看全部或按特定语言筛选

会话 ID 使用去掉连字符的 UUID 生成（`newContextID`），每个会话对应一个 `.ipynb` 路径（`newIpynbPath` 会自动创建必要的目录结构）。

**预热缓存**是一个重要的性能优化：`defaultLanguageSessions` 为每种语言维护一个预创建的"默认会话"。当用户不指定上下文 ID 执行代码时，SDK 使用默认会话，避免了首次执行时创建 kernel 的冷启动延迟。`createDefaultLanguageJupyterContext()` 在 execd 启动时预热这些会话。

`searchKernel()` 在查找匹配语言的 kernel spec 时有一个值得注意的细节：它会跳过名为 "python3" 的 kernel spec。这是因为默认的 python3 kernel 总是存在，如果不跳过它，任何语言搜索都可能错误地匹配到 Python kernel。只有在没有找到其他匹配项时，才会最终退回到 python3。

## 9.5 支持的语言

通过 Code Interpreter 镜像（`sandboxes/code-interpreter/`），execd 支持以下语言的有状态执行：

- **Python** — 通过 IPython kernel，支持丰富的数据科学生态
- **Java** — 通过 IJava kernel
- **Go** — 通过 GoNB kernel
- **TypeScript** — 通过 ts-node 或 Deno kernel
- **SQL** — 通过 `sql.go` 中的专用处理逻辑

每种语言对应一个 Jupyter kernel spec，kernel 的安装和配置在 Code Interpreter 镜像构建时完成。`language.go` 定义了语言枚举和映射关系，确保 SDK 传入的语言标识符能正确路由到对应的 kernel。

## 9.6 SQL 执行的特殊处理

`components/execd/pkg/runtime/sql.go` 为 SQL 执行提供了独立的处理路径。与其他语言通过 Jupyter kernel 执行不同，SQL 可能需要连接到外部数据库。这个文件封装了数据库连接管理和查询执行逻辑，将 SQL 查询结果格式化为与 Jupyter 执行结果一致的输出格式，保持了客户端接口的统一性。

## 本章小结

execd 的设计展现了"简单接口，复杂实现"的工程美学。对外，它只暴露 HTTP API；对内，它精确管理着进程组、信号转发、Jupyter WebSocket 会话、kernel 互斥锁和预热缓存。命令执行中 SIGCHLD/SIGURG 的排除、进程组隔离、WaitGroup 同步等细节，都是从生产环境中提炼出的最佳实践。Jupyter 集成则巧妙地将 kernel 的单线程约束转化为 mutex 锁的并发控制，配合 context 取消实现了优雅的资源回收。
