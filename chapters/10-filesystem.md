# 第10章 文件系统操作

> "在 Unix 中，万物皆文件。在沙箱中，文件即接口。" —— 作者

## 10.1 execd 文件操作 API

沙箱内的文件操作由 execd 守护进程提供，控制器实现位于 `components/execd/pkg/web/controller/filesystem.go`（核心操作）、`filesystem_upload.go`（上传）和 `filesystem_download.go`（下载）。execd 暴露了 10 个精心设计的 RESTful 端点：

| 端点 | 方法 | 功能 |
|------|------|------|
| `/files/info` | GET | 获取文件元数据（大小、权限、时间戳） |
| `/files` | DELETE | 删除文件 |
| `/files/permissions` | POST | 修改文件权限（chmod） |
| `/files/mv` | POST | 移动或重命名文件 |
| `/files/search` | GET | Glob 模式搜索文件 |
| `/files/replace` | POST | 文本内容替换 |
| `/files/upload` | POST | Multipart 文件上传 |
| `/files/download` | GET | 文件下载（支持 Range 206 部分内容） |
| `/directories` | POST | 创建目录 |
| `/directories` | DELETE | 递归删除目录 |

为什么选择 exec-based 的文件操作模式（通过 HTTP API 调用 execd 来执行文件操作），而非直接挂载宿主机文件系统？核心原因是**安全隔离**。如果通过 volume mount 共享文件系统，恶意代码可能利用符号链接、硬链接或竞态条件（TOCTOU）逃逸到宿主机目录。而通过 execd API 操作文件，所有请求都经过认证和参数校验，文件操作的执行者是沙箱内部的 execd 进程，天然受限于容器的文件系统命名空间。

### 文件信息与搜索

`GetFilesInfo()` 接收文件路径列表，返回每个文件的完整元数据。实现中使用了 syscall 级别的 stat 信息获取 owner UID/GID，再通过 OS 用户查找翻译为人类可读的用户名和组名。

`SearchFiles()` 支持 glob 模式匹配，通过递归遍历目录树收集匹配文件。结果不仅包含路径，还附带了完整的文件属性信息，减少了客户端多次 API 调用的需要。

### 文件内容操作

`ReplaceContent()` 实现了文件内的文本替换——读取文件内容、执行字符串替换、以原始文件权限模式写回。这个看似简单的操作为什么要作为独立 API 暴露？因为在 AI Agent 场景下，代码修改是高频操作。如果每次修改都需要先下载整个文件、客户端替换、再上传回去，网络往返开销和文件一致性风险都会大幅增加。

### 文件上传与下载

上传端点 `/files/upload` 采用 multipart 表单格式，这是 HTTP 文件传输的标准方式，任何 HTTP 客户端都能直接使用。

下载端点 `/files/download` 支持 HTTP Range 头，返回 206 Partial Content 响应。这一设计允许大文件的断点续传和分块下载，对于下载日志文件、数据集等大文件场景至关重要。SDK 的下载方法在底层利用 Range 请求实现了流式读取，避免将整个文件加载到内存。

### 目录操作

目录创建（`MakeDirs()`）支持指定权限位，删除（`RemoveDirs()`）默认递归删除。将目录操作与文件操作分离到不同端点，遵循了 RESTful 的资源建模原则——目录和文件是不同类型的资源，拥有不同的操作语义。

## 10.2 SDK 层封装

在 SDK 层面，文件操作通过 `sandbox.files` 属性暴露为 Filesystem 服务。以 Python SDK 为例，`services/` 目录下的 Filesystem Protocol 定义了完整的文件操作接口，而 `adapters/` 层将这些接口映射为 execd HTTP 调用。

用户代码因此变得极为直观：

```python
# 写入文件
await sandbox.files.write("/app/config.json", json_content)

# 读取文件
content = await sandbox.files.read("/app/output.txt")

# 上传本地文件
await sandbox.files.upload("/local/data.csv", "/sandbox/data.csv")

# Glob 搜索
matches = await sandbox.files.search("/app/**/*.py")

# 修改权限
await sandbox.files.chmod("/app/script.sh", "755")
```

SDK 封装的价值不仅在于简化 API 调用，更在于**抽象层次的提升**。用户无需关心 multipart 编码、Range 头计算、HTTP 状态码解析等底层细节，Filesystem 服务将所有这些复杂性隐藏在简洁的方法签名后面。

## 10.3 存储卷挂载：三种后端

除了通过 execd API 进行运行时文件操作，OpenSandbox 还支持在沙箱创建时挂载外部存储卷。三种存储后端对应不同的使用场景：

### Host Path 卷

将宿主机目录直接挂载到沙箱内部，适用于开发环境中需要共享代码或数据的场景。

安全性是 Host Path 挂载最大的顾虑。`server/src/services/docker.py` 实现了**白名单验证**机制（`allowed_host_paths`）：管理员在配置文件中声明允许挂载的宿主机路径列表，创建请求中的 Host Path 必须落在白名单范围内，否则拒绝。此外还支持 `readOnly` 标记（只读挂载）和 `subPath`（子路径选择，并包含路径遍历攻击的防护检查）。

### PVC 卷

PVC（Persistent Volume Claim）是跨运行时的持久化存储抽象：

- **Docker 运行时**：映射为 Docker named volume，生命周期独立于容器
- **Kubernetes 运行时**：映射为原生的 PersistentVolumeClaim 资源

这种抽象让用户代码无需关心底层运行时差异，同一份沙箱配置可以在 Docker 和 Kubernetes 环境间无缝切换。PVC 同样支持 `readOnly` 和 `subPath` 选项。

### OSSFS 卷（阿里云 OSS）

OSSFS 卷将阿里云 OSS（Object Storage Service）对象存储挂载为沙箱内的文件系统，实现在 `server/src/services/ossfs_mixin.py` 中。这是三种后端中实现最复杂的一种：

**版本支持**：同时兼容 OSSFS v1.0 和 v2.0。v1.0 通过临时密码文件传递凭证（格式 `bucket:accessKeyId:accessKeySecret`，权限 0600），v2.0 生成配置文件使用 CLI 风格的选项。临时文件在挂载完成后立即删除，最小化凭证暴露窗口。

**引用计数**：多个沙箱可能挂载同一个 OSS 路径。`_ossfs_mount_ref_counts` 字典配合 `_ossfs_mount_lock` 锁实现了线程安全的引用计数——首次挂载执行实际的 OSSFS mount 命令，后续挂载仅递增计数器。释放时递减计数器，归零时执行实际卸载。这避免了重复挂载相同 OSS 路径的资源浪费和潜在冲突。

**命令注入防护**：由于 OSSFS 挂载需要构造并执行 shell 命令，输入验证至关重要。四个验证函数分别检查：
- Bucket 名称：只允许 3-63 个字符的小写字母、数字和连字符
- OSSFS 选项：屏蔽分号、管道、反引号、美元符号、括号、重定向等 shell 元字符
- 挂载路径：必须为绝对路径，拒绝 shell 元字符和空格
- Endpoint URL：同样拒绝 shell 元字符

**超时与回滚**：OSSFS mount 命令设置了 30 秒的子进程超时。如果挂载失败，系统自动执行回滚——先尝试 `fusermount -u`，若失败再尝试 `umount`，确保不留下半挂载的脏状态。

## 10.4 Volume 模型与验证

`server/src/api/schema.py` 中定义了统一的 Volume 模型：

```python
Volume(
    name: str,          # 卷名称
    host: HostVolume,   # Host Path 后端（三选一）
    pvc: PvcVolume,     # PVC 后端（三选一）
    ossfs: OssfsVolume, # OSSFS 后端（三选一）
    mount_path: str,    # 容器内挂载路径
    read_only: bool,    # 是否只读
    sub_path: str       # 子路径选择
)
```

模型验证器强制执行**恰好一个后端**的约束：如果同时指定了 host 和 pvc，或者三者都未指定，验证器会抛出明确的错误信息。这种"编译期"的配置校验将错误拦截在请求发送之前，避免了在容器创建过程中才发现配置问题的高昂代价。

SDK 层面同样镜像了这个验证逻辑——JavaScript SDK 的 `Sandbox.create()` 中会在客户端验证 volume 配置的合法性，实现了双重保护。

## 10.5 设计权衡

文件系统的设计体现了安全性与便利性之间的权衡：

**exec-based 操作**（通过 execd API）是默认和推荐的方式。它提供了最强的安全隔离——所有文件操作都在容器命名空间内执行，经过认证和权限控制。代价是每次操作都有 HTTP 往返的延迟。

**Volume 挂载**适用于需要高吞吐量 I/O 或共享大量数据的场景。Host Path 挂载风险最高但性能最好，PVC 在安全性和持久化之间取得平衡，OSSFS 则为云原生场景提供了对象存储的无缝集成。

选择哪种方式取决于具体场景：AI Agent 执行零散的文件操作用 exec-based API 足矣；数据科学工作负载处理 GB 级数据集则需要 PVC 或 OSSFS 挂载。OpenSandbox 同时提供两种路径，让用户根据安全性需求和性能要求做出合适的选择。

## 本章小结

文件系统操作是沙箱与外部世界交换数据的关键通道。execd 的 10 个 API 端点覆盖了文件操作的完整语义——从元数据查询到内容替换，从 multipart 上传到 Range 下载。三种存储卷后端（Host Path、PVC、OSSFS）覆盖了从开发到生产的不同需求，而引用计数、白名单验证、命令注入防护等机制确保了安全性不被便利性所牺牲。这种"安全为先，灵活为辅"的设计原则贯穿了整个文件系统架构。
