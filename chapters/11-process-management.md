# 第11章 进程管理与输出流

> "Unix 的哲学是：一个程序只做一件事，并把它做好。进程是操作系统的基本执行单元，管理好进程，就管理好了系统的脉搏。"
> —— Ken Thompson

沙箱的核心价值在于隔离执行。当 AI Agent 需要运行一段 shell 命令时，OpenSandbox 的 execd 组件承担了从 shell 选择、进程创建、信号转发到输出流采集的全部职责。本章将深入分析 `components/execd/pkg/runtime/command.go` 中的进程管理设计，理解每个决策背后的 "为什么"。

## Shell 选择：兼容性优先

execd 启动命令的第一步是选择 shell 解释器。`getShell()` 函数的逻辑极其简洁：优先查找 `bash`，找不到则退回 `sh`。

```go
func getShell() string {
    if _, err := exec.LookPath("bash"); err == nil {
        return "bash"
    }
    return "sh"
}
```

为什么不直接硬编码 `bash`？因为 OpenSandbox 支持多种基础镜像，Alpine 等轻量镜像默认只有 `sh`。这个 fallback 机制确保了 execd 在任何 Linux 环境下都能正常工作，而无需强制用户安装额外的包。命令最终通过 `exec.CommandContext(ctx, shell, "-c", request.Code)` 执行，`-c` 参数让 shell 将整段字符串作为命令解释。

## 进程组隔离：Setpgid 的深意

在 `runCommand()` 和 `runBackgroundCommand()` 中，都设置了 `Setpgid: true`：

```go
cmd.SysProcAttr = &syscall.SysProcAttr{
    Setpgid:    true,
    Credential: cred,
}
```

为什么需要独立的进程组？沙箱中的命令可能会 fork 出子进程（例如 `npm install` 会启动多个并行下载进程）。如果不设置独立进程组，这些子进程会继承 execd 的进程组，导致两个严重问题：一是无法通过 `kill(-pgid, signal)` 一次性终止整个命令树；二是信号转发可能误伤 execd 自身。`Setpgid: true` 让命令及其所有子进程形成独立的进程组，使得中断操作可以精准作用于目标命令树，而不波及 execd 守护进程。

## 用户凭据：buildCredential 的多层考量

`buildCredential()` 函数根据可选的 UID/GID 参数构建 `syscall.Credential`，其设计体现了三层考量：

1. **可选性**：UID 和 GID 均为指针类型，`nil` 表示不切换用户，以 execd 当前身份运行。
2. **主组推导**：当提供 UID 但未提供 GID 时，通过 `user.LookupId()` 查询系统用户数据库，自动获取该用户的主组 GID。
3. **附属组加载**：通过 `u.GroupIds()` 加载所有附属组（supplementary groups），确保命令拥有与目标用户登录时完全一致的权限集合。

这样的设计让 Coding Agent 可以灵活地以特定用户身份执行命令，例如以 `node` 用户运行 npm 脚本，同时正确继承该用户的文件访问权限。

## 信号转发：精确过滤的艺术

前台命令执行期间，execd 通过 `signal.Notify(signals)` 捕获所有信号，并转发给命令的进程组：

```go
if sig != syscall.SIGCHLD && sig != syscall.SIGURG {
    _ = syscall.Kill(-cmd.Process.Pid, sig.(syscall.Signal))
}
```

为什么排除 SIGCHLD 和 SIGURG？SIGCHLD 是子进程终止时内核发给父进程的通知信号，转发它会导致命令进程收到虚假的子进程退出信号。SIGURG 用于 TCP 带外数据通知，Go runtime 内部也使用它做 goroutine 抢占调度，转发它会干扰命令进程的正常 I/O 操作。注意这里使用负 PID（`-cmd.Process.Pid`）来向整个进程组发送信号，而不是仅发给主进程。

## 输出流分离：前台与后台的不同策略

**前台命令** 将 stdout 和 stderr 分别写入独立文件，通过 `c.stdLogDescriptor(session)` 获取两个独立的文件描述符。随后启动两个并发 goroutine 分别 tail 这两个文件，通过 `OnExecuteStdout` 和 `OnExecuteStderr` 回调实时推送给客户端：

```go
wg.Add(2)
safego.Go(func() {
    defer wg.Done()
    c.tailStdPipe(stdoutPath, request.Hooks.OnExecuteStdout, done)
})
safego.Go(func() {
    defer wg.Done()
    c.tailStdPipe(stderrPath, request.Hooks.OnExecuteStderr, done)
})
```

为什么要分离？因为 AI Agent 需要区分正常输出和错误输出来判断命令执行是否成功。例如编译命令的 stderr 包含警告和错误信息，混合输出会导致 Agent 无法准确解析执行结果。

**后台命令** 则合并 stdout/stderr 到同一个文件（`combinedOutputDescriptor`），因为后台命令的输出通常通过 API 异步查询（`GET /command/{id}/logs`），不需要实时区分。同时，后台命令将 stdin 重定向到 `/dev/null`，防止交互式程序阻塞等待输入。

## 后台命令的生命周期管理

后台命令有一套完整的状态跟踪机制。`commandKernel` 结构体记录了 PID（初始值 `-1`，启动后更新为真实 PID）、启动时间、运行状态和命令内容。通过 `GET /command/status/{id}` 可以查询命令的 `CommandStatus`，包含 session ID、运行状态、退出码、错误信息和时间戳。

当 context 被取消时（例如沙箱超时），后台命令通过专门的 goroutine 向整个进程组发送 SIGKILL：

```go
safego.Go(func() {
    <-ctx.Done()
    if cmd.Process != nil {
        _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
    }
})
```

这确保了即使命令 fork 了大量子进程，超时后也能彻底清理。

## 中断机制：三种场景的统一处理

execd 提供了三种中断入口：`DELETE /command` 中断前台命令、`DELETE /code` 中断代码执行、以及 Jupyter kernel 的中断信号。`interrupt.go` 中的中断逻辑采用优雅退出策略：先发 SIGTERM 等待 3 秒，若进程未退出再发 SIGKILL，最后通过循环检测确认终止完成。这种两阶段策略给了进程清理资源的机会（如关闭数据库连接、刷新缓冲区），同时保证了最终一定能终止。

## Docker PID 限制

在 Docker 运行时中，默认的 `pids_limit=512` 限制了容器内的最大进程数。这是防止 fork 炸弹的重要防线——恶意或错误的代码可能通过无限 fork 子进程耗尽系统资源。512 的默认值为常规开发工作负载提供了充足的进程空间，同时有效防止了资源滥用。这个配置在 `server/src/config.py` 中定义，可通过配置文件调整。

## 退出码保留

`runCommand()` 仔细保留了命令的退出码。通过 `errors.As(err, &exitError)` 解包 `exec.ExitError`，提取真实的退出码并通过 `OnExecuteError` 回调返回给调用方。这对 AI Agent 至关重要——Agent 需要根据退出码判断命令是否成功（0 为成功，非 0 为失败），不同的退出码还可能指示不同的失败原因（如 127 表示命令未找到，137 表示被 SIGKILL 终止）。

## 本章小结

execd 的进程管理设计围绕三个核心原则展开：**隔离性**（进程组隔离、用户凭据切换）、**可观测性**（stdout/stderr 分离、状态查询 API、退出码保留）和**可控性**（信号转发、优雅中断、PID 限制）。这些设计使得 AI Agent 能够像一个经验丰富的运维工程师一样，精确地执行命令、监控输出、处理异常，而无需关心底层进程管理的复杂细节。关键源码路径包括 `components/execd/pkg/runtime/command.go`（进程执行核心）、`components/execd/pkg/runtime/interrupt.go`（中断逻辑）、`components/execd/pkg/runtime/command_status.go`（状态追踪）和 `components/execd/pkg/web/controller/command.go`（HTTP API 层）。
