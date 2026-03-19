# 第17章 RL 训练环境支持

> "The key to artificial intelligence has always been the representation." —— Jeff Hawkins

强化学习（Reinforcement Learning）的核心循环是 Agent 与环境的交互：观察状态、执行动作、获取奖励。这个循环对执行环境有着严格的要求——隔离性、可复现性和资源可控性缺一不可。OpenSandbox 的容器化沙箱恰好满足了这些需求，`examples/rl-training/` 目录提供了一个完整的 CartPole DQN 训练示例，展示了如何将沙箱作为 RL 训练的基础设施。

## 17.1 RL 训练为什么需要沙箱

传统 RL 训练通常在本地环境或共享服务器上运行 Gym 环境。这种方式在实验阶段尚可接受，但在规模化训练和生产部署中存在明显问题：

- **环境污染**：多个训练实验共享 Python 包和系统状态，一个实验安装的依赖可能影响另一个
- **资源争抢**：多个训练进程竞争 CPU 和内存，导致训练速度不稳定，影响结果的可复现性
- **安全风险**：RL Agent 可能执行任意代码（尤其在 code-as-action 范式中），缺乏隔离可能危及宿主机

OpenSandbox 沙箱为每个训练 episode 或训练批次提供独立的容器环境。容器在训练开始时创建，训练结束后销毁，确保每次实验都从干净状态开始。

## 17.2 沙箱作为 RL 环境的映射

RL 环境的标准接口（如 Gymnasium 的 `reset()` / `step()`）可以自然地映射到沙箱操作：

| RL 概念 | 沙箱操作 | OpenSandbox API |
|---------|---------|-----------------|
| `reset()` | 创建新沙箱 | `POST /sandboxes` |
| `step(action)` | 在沙箱中执行命令/代码 | execd `POST /command` 或 `POST /code` |
| `observe()` | 读取沙箱状态 | execd `GET /files/info`、`GET /metrics` |
| `reward()` | 从执行结果计算奖励 | 解析命令输出或文件内容 |
| `close()` | 销毁沙箱 | `DELETE /sandboxes/{id}` |

这个映射的关键洞察是：**容器的生命周期与 RL episode 的生命周期对齐**。每个 episode 开始时创建全新的沙箱，结束时销毁。容器的隔离性保证了 episode 之间不存在状态泄露，这是可复现训练的基本前提。

## 17.3 CartPole DQN 示例解析

`examples/rl-training/` 目录包含四个文件：

```
rl-training/
├── main.py              # 训练主脚本
├── requirements.txt     # 依赖声明
├── README.md            # 使用说明
└── screenshot.jpg       # 运行效果截图
```

训练工作流分为以下步骤：

**第一步：创建沙箱环境**。通过 Python SDK 调用 Lifecycle API 创建一个新的沙箱容器。容器基于 code-interpreter 镜像，预装了 Python 运行时。

**第二步：安装训练依赖**。通过 execd API 在沙箱中执行 `pip install` 命令，安装 PyTorch、Gymnasium 等 RL 训练所需的库。这一步在沙箱内完成，不会影响宿主机环境。

**第三步：执行训练循环**。将完整的 DQN 训练代码通过 execd 的代码执行 API（`POST /code`）发送到沙箱中执行。训练过程通过 SSE（Server-Sent Events）实时流式输出日志。

**第四步：收集训练结果**。训练完成后，通过 execd 的文件 API 下载模型检查点和训练报告（JSON 格式）。

示例支持通过环境变量定制训练参数：

```bash
SANDBOX_DOMAIN=localhost:8080    # 服务地址
SANDBOX_API_KEY=your-key         # 认证密钥
SANDBOX_IMAGE=custom-image       # 自定义镜像
RL_TIMESTEPS=5000                # 训练步数
```

## 17.4 资源控制与训练稳定性

RL 训练对资源的可预测性要求很高。如果训练过程中 CPU 时间被其他进程抢占，同样的超参数在不同运行中可能产生不同的结果。OpenSandbox 提供了多维度的资源控制：

**CPU 和内存限制**：通过 `CreateSandboxRequest` 中的 resource limits 字段，可以为每个训练沙箱指定精确的 CPU 核数（nano_cpus）和内存上限（mem_limit）。在 Docker 后端，这些参数直接映射到 cgroup 限制；在 Kubernetes 后端，映射到 Pod 的 resources.limits。

**PID 限制**：`DockerConfig` 中的 `pids_limit`（默认 512）防止训练代码意外 fork 过多进程。这在使用多进程并行环境（如 SubprocVecEnv）时尤为重要——如果进程数超出限制，系统会明确报错而非静默降级。

**超时控制**：`server/src/config.py` 中的 `max_sandbox_timeout` 和 `CreateSandboxRequest` 中的 `expires_at` 字段为每个训练沙箱设置最大存活时间。训练超时后沙箱自动销毁，防止失控的训练进程无限期占用资源。

## 17.5 实时监控训练过程

execd 组件提供了两个监控端点，对 RL 训练过程的可观测性至关重要：

- **`GET /metrics`**：返回当前时刻的资源使用快照，包括 `cpu_cores`（核心数）、`cpu_usage`（使用率，float）、`memory_mib`（内存使用量）和 `timestamp`（毫秒级时间戳）
- **`GET /metrics/watch`**：通过 SSE 实时推送资源指标流

训练框架可以利用这些指标检测异常状态：如果内存使用持续增长接近上限，可能存在内存泄漏；如果 CPU 使用率骤降为零，训练可能已经死锁。这种实时监控能力使得训练问题的定位从"事后分析日志"变为"实时发现异常"。

## 17.6 批量并行训练

RL 研究中常常需要用不同随机种子或不同超参数运行多次实验来评估算法的稳定性。BatchSandbox CRD 天然支持这种场景：

```yaml
apiVersion: sandbox.opensandbox.io/v1alpha1
kind: BatchSandbox
spec:
  replicas: 10
  poolRef:
    name: rl-training-pool
  taskTemplate:
    spec:
      processTask:
        command: ["python"]
        args: ["/workspace/train.py"]
        timeout: 3600
  shardTaskPatches:
    - spec:
        processTask:
          env:
            - name: RANDOM_SEED
              value: "42"
    - spec:
        processTask:
          env:
            - name: RANDOM_SEED
              value: "123"
    # ... 每个分片使用不同的随机种子
```

通过 ShardTaskPatches，每个训练副本可以接收不同的随机种子或超参数。BatchSandbox Status 中的 TaskSucceed 和 TaskFailed 计数器让研究者一眼看到有多少训练成功完成。结合 Pool CRD 的预热机制，10 个训练副本可以几乎同时启动，而不必等待镜像拉取。

## 17.7 为什么沙箱适合 RL 训练

总结 OpenSandbox 在 RL 训练场景中的设计优势：

**隔离性映射 episode 独立性**：容器的生命周期天然对应 episode 的生命周期，无需在应用层实现环境重置逻辑。

**可复现性源于确定性环境**：相同的镜像 + 相同的资源限制 + 相同的随机种子 = 相同的训练轨迹。

**安全性应对任意代码执行**：在 code-as-action 范式中，Agent 生成的代码在沙箱内执行，即使产生危险操作也不会影响宿主机。安全配置（dropped capabilities、AppArmor、Seccomp）提供了多层防护。

**弹性扩展匹配训练规模**：从单个实验到数百个并行训练，只需调整 Replicas 数量和 Pool 容量。

## 本章小结

OpenSandbox 为 RL 训练提供了从单实验到规模化训练的完整支持。容器生命周期与 RL episode 的自然映射消除了环境管理的复杂性，资源限制保证了训练的可复现性，execd 的实时监控使得训练过程透明可观测。`examples/rl-training/` 中的 CartPole DQN 示例展示了这套方案的实际用法，而 BatchSandbox CRD 将其扩展到了大规模并行训练场景。理解沙箱与 RL 环境之间的映射关系，是在 OpenSandbox 上构建高效训练流水线的第一步。
