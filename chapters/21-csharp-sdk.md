# 第21章 C# SDK 设计

> "在 .NET 中，最好的 API 是那些让你忘记 API 本身存在的 API。" —— 微软 .NET 团队

## 21.1 包结构与工程架构

C# SDK 位于 `sdks/sandbox/csharp/src/OpenSandbox/`，是 OpenSandbox 多语言 SDK 矩阵中的重要一环。与 Python SDK 和 JavaScript SDK 一样，C# SDK 同样遵循跨语言 API 一致性原则，但在技术选型上充分体现了 .NET 生态的特色。

```
OpenSandbox/
├── Adapters/           # HTTP 适配层实现
├── Config/             # 连接配置管理
├── Core/               # 核心基础设施（常量、异常）
├── Factory/            # 工厂模式与依赖注入
├── Internal/           # 内部实现细节
├── Models/             # 数据模型定义
├── Services/           # 服务接口定义
├── HttpClientProvider.cs
├── Options.cs          # 选项类定义
├── Sandbox.cs          # Sandbox 核心类
├── SandboxManager.cs   # 批量管理器
└── OpenSandbox.csproj
```

C# SDK 的目标框架覆盖了 `netstandard2.0`、`netstandard2.1` 以及 `net6.0` 到 `net10.0`，实现了真正的全平台支持。这种多目标框架策略意味着 SDK 可以在 .NET Framework 4.6.1+、.NET Core 2.0+ 以及最新的 .NET 10 上运行，无论是 Windows 桌面应用、Xamarin 移动应用还是 ASP.NET Core 后端服务，都能无缝集成。

工程依赖方面，SDK 仅引入了三个核心包：`Microsoft.Extensions.Logging.Abstractions` 用于日志抽象、`System.Text.Json` 用于 JSON 序列化、以及 `PolySharp` 用于生成 C# 9+ 特性的降级实现。这种轻量级依赖策略避免了引入不必要的外部依赖，让 SDK 成为真正的"零负担"库。

## 21.2 Sandbox 核心类

`Sandbox.cs` 是整个 C# SDK 的核心入口，采用了静态工厂方法模式提供三种实例化路径：

```csharp
// 创建全新沙箱
Sandbox sandbox = await Sandbox.CreateAsync(new SandboxCreateOptions
{
    Image = "mcr.microsoft.com/dotnet/sdk:8.0",
    Env = new Dictionary<string, string>
    {
        { "DOTNET_CLI_TELEMETRY_OPTOUT", "1" }
    },
    NetworkPolicy = new NetworkPolicy
    {
        DefaultAction = NetworkRuleAction.Allow
    }
});

// 连接已有沙箱
Sandbox sandbox = await Sandbox.ConnectAsync(new SandboxConnectOptions
{
    SandboxId = "existing-sandbox-id"
});

// 恢复暂停的沙箱
Sandbox sandbox = await Sandbox.ResumeAsync(new SandboxConnectOptions
{
    SandboxId = "paused-sandbox-id"
});
```

为什么采用静态工厂方法而非构造函数？原因与 Python SDK 类似——沙箱的创建涉及异步网络调用，需要向 lifecycle server 发送创建请求、轮询等待容器就绪。`async Task<T>` 返回类型使得工厂方法能够优雅地处理这一异步流程。

Sandbox 实例通过属性暴露服务访问：

```csharp
sandbox.Commands    // → IExecdCommands：命令执行与后台任务
sandbox.Files       // → ISandboxFiles：文件系统操作
sandbox.Health      // → IExecdHealth：健康检查
sandbox.Metrics     // → IExecdMetrics：资源监控
```

这种属性代理设计让用户代码读起来自然流畅：`await sandbox.Files.WriteAsync("/tmp/data.txt", content)` 就是"在沙箱的文件系统中写入内容"。

## 21.3 完整的生命周期管理

C# SDK 提供了精细的生命周期操作方法集：

| 方法 | 描述 |
|------|------|
| `PauseAsync()` | 暂停沙箱，冻结状态 |
| `ResumeAsync()` | 恢复暂停的沙箱，返回新连接实例 |
| `KillAsync()` | 永久终止远程实例（不可逆） |
| `RenewAsync()` | 延长沙箱过期时间 |
| `GetInfoAsync()` | 获取完整状态信息 |
| `IsHealthyAsync()` | 执行健康检查 |
| `GetMetricsAsync()` | 查看 CPU、内存等资源用量 |
| `WaitUntilReadyAsync()` | 以轮询方式等待沙箱就绪 |

值得注意的是 `CreateAsync` 方法内部的**防御性清理机制**：如果沙箱创建过程中出现异常（例如超时或镜像拉取失败），SDK 会自动尝试调用 `DeleteSandboxAsync` 销毁已创建的远程实例，避免留下僵尸容器。这种设计在生产环境中至关重要，可以防止资源泄漏。

```csharp
try
{
    var created = await sandboxes.CreateSandboxAsync(request, cancellationToken);
    sandboxId = created.Id;
    // ... 后续初始化逻辑
}
catch (Exception ex)
{
    if (sandboxId != null)
    {
        try
        {
            await sandboxes.DeleteSandboxAsync(sandboxId, CancellationToken.None);
        }
        catch
        {
            // 忽略清理失败，优先抛出原始错误
        }
    }
    throw;
}
```

## 21.4 网络策略与端点管理

网络相关操作通过以下方法暴露：

```csharp
// 获取指定端口的端点信息
Endpoint endpoint = await sandbox.GetEndpointAsync(8080);

// 直接获取可访问的 URL 字符串
string url = await sandbox.GetEndpointUrlAsync(8080);

// 查询当前出口流量策略
NetworkPolicy policy = await sandbox.GetEgressPolicyAsync();

// 增量更新出口规则（sidecar merge 语义）
await sandbox.PatchEgressRulesAsync(new List<NetworkRule>
{
    new NetworkRule { Target = "api.example.com", Action = NetworkRuleAction.Allow }
});
```

`PatchEgressRulesAsync` 采用了巧妙的**sidecar merge 语义**：新规则与同目标的现有规则相比具有优先级，其他目标的现有规则保持不变，同一 patch payload 中同一目标的第一个规则生效，当前 defaultAction 被保留。这种设计让网络策略的动态调整变得安全且可预测。

## 21.5 异步资源管理

C# SDK 实现了 `IAsyncDisposable` 接口，支持 `await using` 语法实现自动资源清理：

```csharp
await using var sandbox = await Sandbox.CreateAsync(new SandboxCreateOptions
{
    Image = "mcr.microsoft.com/dotnet/sdk:8.0"
});

var result = await sandbox.Commands.RunAsync("dotnet --version");
// 退出 using 块时自动调用 DisposeAsync() 释放连接资源
```

这里有一个关键的设计区分：`DisposeAsync()` 仅释放本地 SDK 资源（HTTP 客户端和适配器），并不会终止远程沙箱实例。沙箱会继续运行直到超时过期。如果用户需要立即销毁沙箱，应在 using 块内显式调用 `KillAsync()`。

## 21.6 SandboxManager：批量管理

当需要管理多个沙箱时，`SandboxManager` 提供了行政层面的操作能力：

```csharp
using var manager = SandboxManager.Create(new SandboxManagerOptions
{
    ConnectionConfig = new ConnectionConfig(new ConnectionConfigOptions
    {
        Domain = "api.opensandbox.io"
    })
});

// 列出所有沙箱，支持过滤条件
var sandboxes = await manager.ListSandboxInfosAsync(new SandboxFilter
{
    States = new List<string> { "Running", "Paused" },
    Page = 1,
    PageSize = 20
});

// 查询特定沙箱详情
var info = await manager.GetSandboxInfoAsync("sandbox-123");

// 批量生命周期操作
await manager.KillSandboxAsync("sandbox-123");
await manager.PauseSandboxAsync("sandbox-456");
await manager.ResumeSandboxAsync("sandbox-456");

// 为指定沙箱续期
await manager.RenewSandboxAsync("sandbox-789", 3600); // 延后1小时
```

SandboxManager 采用**静态工厂方法** `Create()` 实例化（注意不是异步方法），因为它只需要初始化本地连接资源，不涉及远程沙箱的创建。这种设计符合 .NET 异步编程的惯例——只有在真正需要等待 I/O 时才使用 async。

## 21.7 适配器工厂与依赖注入

C# SDK 采用了**适配器工厂模式**实现 HTTP 客户端的创建与管理。`IAdapterFactory` 接口定义了三种栈的创建方法：

```csharp
public interface IAdapterFactory
{
    LifecycleStack CreateLifecycleStack(CreateLifecycleStackOptions options);
    ExecdStack CreateExecdStack(CreateExecdStackOptions options);
    EgressStack CreateEgressStack(CreateEgressStackOptions options);
}
```

这种设计实现了关注点分离：HTTP 传输细节（HttpClient 实例、基础 URL、请求头）被完全隔离在适配层内部，未来若要替换为 `HttpClientFactory` 或其他 HTTP 库，只需修改适配层实现。

对于大多数用户场景，直接使用 `DefaultAdapterFactory.Create()` 即可。但高级用户可以通过自定义 `IAdapterFactory` 实现来注入自己的 HTTP 处理逻辑，例如添加自定义的请求拦截器、响应缓存或重试策略。

```csharp
// 自定义适配器工厂示例
public class CustomAdapterFactory : IAdapterFactory
{
    public LifecycleStack CreateLifecycleStack(CreateLifecycleStackOptions options)
    {
        // 添加自定义日志、监控或重试逻辑
        var wrappedClient = new RetryHttpClientWrapper(options.HttpClientProvider.HttpClient);
        var sandboxes = new SandboxesAdapter(wrappedClient);
        return new LifecycleStack { Sandboxes = sandboxes };
    }
    // ... 其他方法
}
```

## 21.8 连接配置与诊断选项

`ConnectionConfig` 类封装了所有连接相关的配置，支持多种配置来源：

```csharp
// 方式1：代码配置
var config = new ConnectionConfig(new ConnectionConfigOptions
{
    Domain = "api.opensandbox.io",
    Protocol = ConnectionProtocol.Https,
    ApiKey = "your-api-key",
    RequestTimeoutSeconds = 60,
    UseServerProxy = true,
    Headers = new Dictionary<string, string>
    {
        { "X-Custom-Header", "value" }
    }
});

// 方式2：环境变量（OPENSANDBOX_DOMAIN, OPENSANDBOX_API_KEY）
var config = new ConnectionConfig(); // 自动读取环境变量

// 方式3：混合模式
var config = new ConnectionConfig(new ConnectionConfigOptions
{
    Domain = "api.opensandbox.io"
    // ApiKey 等其他配置从环境变量读取
});
```

诊断选项允许用户注入自定义的日志工厂，便于在分布式环境中追踪问题：

```csharp
var options = new SandboxCreateOptions
{
    Image = "mcr.microsoft.com/dotnet/sdk:8.0",
    Diagnostics = new SdkDiagnosticsOptions
    {
        LoggerFactory = LoggerFactory.Create(builder =>
        {
            builder.AddConsole();
            builder.SetMinimumLevel(LogLevel.Debug);
        })
    }
};
```

## 21.9 完善的异常体系

C# SDK 定义了结构化的异常层次结构，将底层 HTTP 错误和业务错误统一包装为 `SandboxException` 及其子类：

```csharp
// 基础异常
public class SandboxException : Exception
{
    public SandboxError Error { get; }      // 结构化错误信息
    public string? RequestId { get; }        // 服务端请求 ID
}

// API 错误（HTTP 层面）
public class SandboxApiException : SandboxException
{
    public int? StatusCode { get; }         // HTTP 状态码
    public object? RawBody { get; }         // 原始响应体
}

// 特定业务异常
public class SandboxReadyTimeoutException : SandboxException { }  // 就绪检查超时
public class SandboxUnhealthyException : SandboxException { }       // 沙箱不健康
public class InvalidArgumentException : SandboxException { }        // 参数错误
public class SandboxInternalException : SandboxException { }       // 内部错误
```

`SandboxError` 类提供了稳定的错误代码，便于程序化处理：

```csharp
public static class SandboxErrorCodes
{
    public const string InternalUnknownError = "INTERNAL_UNKNOWN_ERROR";
    public const string ReadyTimeout = "READY_TIMEOUT";
    public const string Unhealthy = "UNHEALTHY";
    public const string InvalidArgument = "INVALID_ARGUMENT";
    public const string UnexpectedResponse = "UNEXPECTED_RESPONSE";
}
```

用户可以捕获基础 `SandboxException` 处理所有 SDK 相关错误，或针对特定异常类型进行精细化处理：

```csharp
try
{
    var sandbox = await Sandbox.CreateAsync(options);
}
catch (SandboxReadyTimeoutException ex)
{
    // 沙箱启动超时，可能是镜像拉取慢或资源不足
    Console.WriteLine($"Timeout: {ex.Message}");
}
catch (SandboxApiException ex) when (ex.StatusCode == 401)
{
    // 认证失败
    Console.WriteLine("Invalid API key");
}
catch (SandboxException ex)
{
    // 其他 SDK 错误
    Console.WriteLine($"[{ex.Error.Code}] {ex.Message}");
}
```

## 21.10 跨语言 API 一致性哲学

与其他三种语言 SDK（Python、JavaScript、Kotlin）一样，C# SDK 严格遵循跨语言 API 一致性原则：

1. **相同的工厂方法签名**：`CreateAsync()` / `ConnectAsync()` / `ResumeAsync()` 在每种语言中语义一致
2. **相同的生命周期动词**：`PauseAsync` / `KillAsync` / `RenewAsync` / `DisposeAsync` 跨语言统一
3. **相同的服务访问模式**：通过属性获取 commands、files、health、metrics 服务
4. **相同的参数结构**：`SandboxCreateOptions`、`SandboxConnectOptions` 等选项类与 Python/JS 版本对齐

这种一致性让 AI Agent 开发者可以在不同技术栈之间自由切换——后端用 Python、前端用 TypeScript、桌面应用用 C#，无需重新学习每种语言的 SDK 用法。

## 本章小结

C# SDK 的设计哲学可以归纳为三个关键词：**全面兼容**（netstandard2.0 到 net10.0）、**异步优先**（async/await 贯穿始终）、**工厂模式**（IAdapterFactory 解耦依赖）。静态工厂方法解决了异步构造的难题，`IAsyncDisposable` 确保了资源安全，而完善的异常体系则让错误处理变得优雅可预测。

适配器工厂模式将 HTTP 传输细节彻底隔离，为高级用户提供了足够的扩展能力。连接配置支持代码、命令行、环境变量多种来源，诊断选项允许注入自定义日志工厂，这些设计共同构成了一个既简洁又强大的 .NET SDK。
