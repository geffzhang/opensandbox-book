# 第16章 Agent 评估框架集成

> "If you can't measure it, you can't improve it." —— Peter Drucker

在 AI Agent 的开发周期中，评估是最容易被忽视却最为关键的环节。一个 Agent 能否正确使用工具、能否在多轮对话中保持一致性、能否处理边界情况——这些问题都需要在隔离环境中批量验证。OpenSandbox 通过 BatchSandbox CRD 和 Pool CRD 构建了一套完整的评估基础设施，使得批量评估从"手工脚本"升级为"声明式编排"。

## 16.1 为什么 AI 评估需要沙箱

传统软件的单元测试在确定性环境中运行，输入输出可预测。但 AI Agent 的评估面临独特挑战：每个评估用例可能执行任意代码、访问文件系统、甚至发起网络请求。如果多个评估用例共享同一个环境，它们之间的状态污染会导致结果不可复现。

OpenSandbox 的设计理念是：**每个评估任务运行在独立的容器中**。这不仅保证了隔离性，还带来了天然的并行能力——只要集群资源允许，数百个评估用例可以同时执行。

典型的评估场景包括：

- **Benchmark 套件执行**：如 SWE-bench、HumanEval 等标准评测集，每个题目需要独立的执行环境
- **A/B 测试**：同一组测试用例分别在不同 Agent 版本上运行，对比通过率
- **回归测试**：每次代码提交后自动运行评估套件，确保能力不退化

## 16.2 BatchSandbox CRD 设计

BatchSandbox 是 OpenSandbox 在 Kubernetes 上的核心批量编排资源，定义在 `kubernetes/apis/sandbox/v1alpha1/batchsandbox_types.go` 中。它的设计围绕一个核心思想：**用声明式的方式描述"我需要 N 个沙箱并行执行 M 个任务"**。

### Spec 关键字段

```go
type BatchSandboxSpec struct {
    Replicas                       *int32              // 并行沙箱数量，默认 1
    PoolRef                        *PoolRef            // 引用预热池（与 Template 互斥）
    Template                       *PodTemplateSpec    // Pod 模板
    ShardPatches                   []PodTemplateSpec   // 每个沙箱的定制化补丁
    TaskTemplate                   *TaskTemplateSpec   // 评估任务模板
    ShardTaskPatches               []TaskTemplateSpec  // 每个任务的定制化补丁
    TaskResourcePolicyWhenCompleted TaskResourcePolicy  // Retain 或 Release
    ExpireTime                     *metav1.Time        // 自动清理时间
}
```

这里有两个精妙的设计决策值得展开。

**ShardPatches 的意义**：在评估场景中，所有沙箱通常使用相同的基础镜像和配置（Template），但每个沙箱需要接收不同的评估数据。ShardPatches 允许对每个副本进行差异化配置——例如通过环境变量注入不同的测试数据分片。这避免了为每个评估用例创建单独的 BatchSandbox 资源。

**TaskResourcePolicyWhenCompleted 的权衡**：任务完成后，沙箱容器是保留还是释放？`Retain` 模式保留容器现场，方便开发者 exec 进去调试失败的评估用例；`Release` 模式立即释放资源，适合大规模批量运行。这个字段把"调试便利性"和"资源效率"的选择权交给了用户。

### Status 中的任务追踪

```go
type BatchSandboxStatus struct {
    Replicas    int32  // 总副本数
    Allocated   int32  // 已分配
    Ready       int32  // 就绪
    TaskRunning int32  // 运行中的任务
    TaskSucceed int32  // 成功的任务
    TaskFailed  int32  // 失败的任务
    TaskPending int32  // 等待中的任务
    TaskUnknown int32  // 未知状态的任务
}
```

五个任务状态计数器（TaskRunning / TaskSucceed / TaskFailed / TaskPending / TaskUnknown）是评估框架的"仪表盘"。外部系统只需 watch 这个 Status 对象，就能实时掌握整个评估批次的进度，而不必逐个查询每个沙箱的状态。这种聚合设计大幅简化了评估编排器的实现。

## 16.3 Pool CRD 与预热机制

评估场景对启动延迟非常敏感。如果每次评估都要从头拉取镜像、创建容器，数百个任务的累计等待时间将不可接受。Pool CRD（定义在 `kubernetes/apis/sandbox/v1alpha1/pool_types.go`）通过预热机制解决了这个问题。

```go
type CapacitySpec struct {
    BufferMax int32  // 最大预热节点数
    BufferMin int32  // 最小预热节点数
    PoolMax   int32  // 池总容量上限
    PoolMin   int32  // 池总容量下限
}
```

Pool 控制器维护一组已创建但尚未分配的"温热"Pod。当 BatchSandbox 通过 PoolRef 引用一个 Pool 时，新沙箱直接从池中获取预热好的 Pod，跳过镜像拉取和容器初始化阶段。BufferMin 和 BufferMax 定义了预热缓冲区的伸缩范围，控制器会自动补充被消耗的预热节点。

**为什么 Pool 约束只允许定制 entrypoint 和 env？** 预热的本质是提前完成重量级初始化。如果允许修改镜像、卷挂载或安全配置，预热的 Pod 就无法被不同的 BatchSandbox 复用。将可定制范围限制为 entrypoint 和环境变量，是在"灵活性"和"复用效率"之间做出的务实取舍。

## 16.4 完整评估工作流

一个典型的评估流程如下：

1. **创建 Pool**：定义基础镜像和预热规模，控制器开始预创建 Pod
2. **创建 BatchSandbox**：指定 Replicas、PoolRef 和 TaskTemplate，通过 ShardPatches 注入每个分片的评估数据
3. **任务分发**：控制器为每个沙箱创建对应的 Task，任务定义包含要执行的命令、参数和超时时间
4. **状态监控**：评估编排器 watch BatchSandbox Status，观察 TaskSucceed 和 TaskFailed 计数器
5. **结果收集**：通过 execd API 从各个沙箱中提取评估结果文件
6. **资源清理**：根据 TaskResourcePolicyWhenCompleted 决定是否保留容器现场

在服务端，`server/src/services/k8s/batchsandbox_provider.py` 实现了 BatchSandbox 的工作负载提供者逻辑。它通过 `list_sandbox_infos` 方法支持按标签和状态过滤沙箱列表，方便评估系统批量查询结果。

## 16.5 为什么选择 CRD 而非 API 编排

一个合理的疑问是：为什么不通过多次调用 Lifecycle API 来实现批量评估，而要引入 CRD？

答案在于**声明式的自愈能力**。如果评估过程中某个 Pod 崩溃，Kubernetes 控制器会自动检测并重建它。如果使用命令式 API 编排，崩溃恢复的逻辑需要评估框架自己实现。CRD 把复杂的状态机管理下沉到 Kubernetes 控制器层面，评估框架只需关注"我要什么"而非"如何实现"。

此外，CRD 资源天然支持 kubectl 操作：`kubectl get bsbx`（bsbx 是 BatchSandbox 的 shortName）可以直接查看评估进度，打印列包含 DESIRED、ALLOCATED、READY 以及各任务状态计数器。这让运维人员无需额外工具就能监控评估任务。

## 本章小结

OpenSandbox 的评估框架集成体现了"将基础设施能力下沉"的设计哲学。BatchSandbox CRD 提供声明式的批量编排，Pool CRD 通过预热消除启动延迟，任务级状态追踪为评估系统提供实时可观测性。这套设计使得 AI Agent 评估从临时脚本演进为可靠的、可扩展的基础设施。对于需要频繁运行评估套件的 AI 团队来说，理解这些 CRD 的设计取舍，是高效利用 OpenSandbox 进行 Agent 质量保障的基础。
