# 深入指南 07：网络

本文档描述了 BoxLite 如何为轻量级虚拟机提供网络连接。内容涵盖从宿主机到客户机的完整数据路径、可插拔的后端架构、DNS 解析、端口转发、通过 MITM（中间人）代理进行的密钥注入，以及各平台之间的差异。

本文档分为两个部分：

- **Part A** -- 精简概述（建议首次阅读）
- **Part B** -- 全面参考（适用于实现者、调试者和贡献者）

---

# Part A：精简版

## A.1 架构一览

BoxLite 为每个虚拟机提供一个虚拟以太网接口（`eth0`），连接到运行在宿主机上的用户态网络栈。无需 root 权限或内核模块。

```mermaid
flowchart TB
    subgraph Host["宿主机进程（BoxLite 运行时）"]
        RT["BoxliteRuntime"]
        Factory["NetworkBackendFactory"]
        GV["GvisorTapBackend<br/><i>主要</i>"]
        LS["LibslirpBackend<br/><i>备选</i>"]
        Instance["GvproxyInstance<br/>（Go via FFI）"]
        Socket["Unix Socket / TCP"]
    end

    subgraph VM["libkrun 虚拟机"]
        VirtIO["virtio-net 设备"]
    end

    subgraph Guest["客户机"]
        ETH["eth0<br/>192.168.127.2/24"]
        Container["容器进程"]
    end

    RT --> Factory
    Factory --> GV
    Factory -.-> LS
    GV --> Instance
    Instance --> Socket
    Socket --> VirtIO
    VirtIO --> ETH
    ETH --> Container
```

**后端选择优先级：**
1. `gvisor-tap-vsock`（gvproxy）-- 主要，功能完整
2. `libslirp` -- 备选，功能有限
3. 无 -- 引擎使用其内置的默认网络

## A.2 虚拟网络拓扑

每个 box 创建一个隔离的 `/24` 虚拟网络：

| 角色 | IP 地址 | MAC 地址 |
|------|---------|----------|
| 网关（gvproxy） | `192.168.127.1` | `5a:94:ef:e4:0c:dd` |
| 客户机虚拟机（eth0） | `192.168.127.2` | `5a:94:ef:e4:0c:ee` |
| 虚拟宿主机 | `192.168.127.254` | -- |
| DNS 服务器 | `192.168.127.1` | （与网关相同） |

- **子网：** `192.168.127.0/24`，MTU `1500`
- **`host.boxlite.internal`** 解析为 `192.168.127.254`，通过 NAT 转发到宿主机的 `127.0.0.1`。

## A.3 核心特性

**端口转发** -- 将宿主机端口映射到客户机端口。用户提供的映射优先；镜像暴露的端口作为备选，使用 1:1 映射。

**DNS 黑洞过滤** -- 当设置了 `allow_net` 时，基于白名单的 DNS 过滤器仅解析被允许的主机名。其他所有请求返回 `0.0.0.0`。`host.boxlite.internal` 别名始终被允许。

**MITM 密钥注入** -- 密钥（如 API 密钥）通过替换占位符字符串注入到出站 HTTP/HTTPS 请求中。每个 box 生成一个短期有效的 ECDSA P-256 CA 证书，gvproxy 拦截匹配的流量以执行替换。

**跨平台支持：**

| 方面 | Linux | macOS | Windows |
|------|-------|-------|---------|
| 套接字类型 | UnixStream | UnixDgram | TCP |
| 协议 | Qemu | VFKit | Qemu over TCP |
| libgvproxy | 静态库 `.a` | 静态库 `.a` | DLL（c-shared） |

## A.4 数据路径

```mermaid
flowchart LR
    A["宿主机应用<br/>:8080"] --> B["宿主机操作系统<br/>内核"]
    B --> C["gvproxy<br/>（套接字监听）"]
    C -->|"端口转发<br/>8080 → 80"| D["Unix socket<br/>桥接"]
    D --> E["libkrun<br/>virtio-net"]
    E --> F["客户机 eth0"]
    F --> G["容器<br/>:80"]
```

## A.5 Go-Rust FFI（外部函数接口）桥接

gvproxy 后端以 Go 库的形式实现，通过 CGO/FFI 链接到 Rust：

| FFI 函数 | 用途 |
|----------|------|
| `gvproxy_create(json_config)` | 创建实例，返回 ID |
| `gvproxy_destroy(id)` | 销毁实例，释放资源 |
| `gvproxy_get_stats(id)` | 获取 JSON 格式的网络统计信息 |
| `gvproxy_set_log_callback(fn_ptr)` | 将 Go 日志桥接到 Rust tracing |
| `gvproxy_get_version()` | 获取 gvisor-tap-vsock 版本 |

日志统一处理：Go `logrus` 消息被转发到 Rust 的 `tracing` 系统，目标为 `"gvproxy"`。通过 `RUST_LOG=gvproxy=debug` 启用。

## A.6 调试快速参考

| 症状 | 需检查的指标 | 可能原因 |
|------|-------------|----------|
| 连接断开 | `tcp.forward_max_inflight_drop > 0` | 由于并发限制导致 SYN 包被丢弃 |
| 启动时无网络 | `bytes_received = 0` | gvproxy 尚未初始化（约 30 秒预热） |
| DNS 失败 | `failed_connection_attempts` 偏高 | DNS 黑洞过滤阻断或路由问题 |
| 传输缓慢 | `retransmits` / `timeouts` 偏高 | 拥塞或丢包 |

---

# Part B：全面版

## B.1 网络架构概述

BoxLite 网络为硬件隔离的虚拟机提供完整的 TCP/IP 连接能力，通过用户态网络栈实现。该架构无需 root 权限、内核模块或宿主机网络命名空间变更。

### B.1.1 组件栈

```mermaid
flowchart TB
    subgraph HostProcess["宿主机进程（BoxLite 运行时）"]
        direction TB
        Runtime["BoxliteRuntime"]
        NBF["NetworkBackendFactory"]

        subgraph Backends["可插拔后端"]
            GVB["GvisorTapBackend"]
            LSB["LibslirpBackend"]
        end

        subgraph GvproxyStack["Gvproxy 栈"]
            GI["GvproxyInstance"]
            FFI["FFI 层<br/>（libgvproxy-sys）"]
            GoCode["Go 层<br/>（gvproxy-bridge）"]
        end

        SocketPath["Unix Socket<br/>/tmp/bl_{id}/net.sock"]
    end

    subgraph VMLayer["libkrun 虚拟机"]
        VirtioNet["virtio-net 设备<br/>（CSUM, TSO4, UFO）"]
    end

    subgraph GuestVM["客户机虚拟机"]
        ETH0["eth0<br/>192.168.127.2/24"]
        ContainerProcess["容器进程"]
    end

    Runtime --> NBF
    NBF --> GVB
    NBF -.->|"备选"| LSB
    GVB --> GI
    GI --> FFI
    FFI --> GoCode
    GoCode --> SocketPath
    SocketPath --> VirtioNet
    VirtioNet --> ETH0
    ETH0 --> ContainerProcess
```

### B.1.2 后端选择

`NetworkBackendFactory::create()` 在编译时通过 Cargo feature flags 选择后端：

```rust
// 优先级顺序：
// 1. gvproxy (feature = "gvproxy")  -- 主要
// 2. libslirp (feature = "libslirp") -- 备选
// 3. None -- 引擎默认
pub fn create(config: NetworkBackendConfig) -> BoxliteResult<Option<Box<dyn NetworkBackend>>>
```

当没有可用后端时，函数返回 `None`，引擎使用其内置网络。

## B.2 NetworkBackend Trait

所有网络后端实现一个通用 trait（特征），将引擎与具体实现解耦：

```rust
pub trait NetworkBackend: Send + Sync + Debug {
    /// 虚拟机引擎的连接信息
    fn endpoint(&self) -> BoxliteResult<NetworkBackendEndpoint>;

    /// 人类可读的后端名称
    fn name(&self) -> &'static str;

    /// 网络统计信息（可选）
    fn metrics(&self) -> BoxliteResult<Option<NetworkMetrics>> {
        Ok(None)
    }
}
```

### B.2.1 NetworkBackendEndpoint

端点告诉引擎如何为虚拟机的网络接口建立连接：

```rust
pub enum NetworkBackendEndpoint {
    UnixSocket {
        path: PathBuf,
        connection_type: ConnectionType,
        mac_address: [u8; 6],
    },
}

pub enum ConnectionType {
    UnixStream,  // Linux: SOCK_STREAM, Qemu 协议
    UnixDgram,   // macOS: SOCK_DGRAM, VFKit 协议
}
```

### B.2.2 NetworkBackendConfig

传递给工厂以创建后端的配置：

```rust
pub struct NetworkBackendConfig {
    pub port_mappings: Vec<(u16, u16)>,      // (宿主机端口, 客户机端口)
    pub socket_path: PathBuf,                 // 每个 box 唯一
    pub allow_net: Vec<String>,               // DNS 黑洞过滤白名单
    pub secrets: Vec<Secret>,                 // MITM 代理密钥
    pub ca_cert_pem: Option<String>,          // MITM CA 证书
    pub ca_key_pem: Option<String>,           // MITM CA 私钥
}
```

## B.3 虚拟网络拓扑

每个 box 在一个隔离的虚拟网络中运行。所有地址都是确定性的并且硬编码，以确保 DHCP 静态租约正常工作。

```mermaid
graph LR
    subgraph VirtualNet["192.168.127.0/24"]
        GW["网关<br/>192.168.127.1<br/>5a:94:ef:e4:0c:dd"]
        VM["客户机虚拟机<br/>192.168.127.2<br/>5a:94:ef:e4:0c:ee"]
        VH["虚拟宿主机<br/>192.168.127.254<br/>（NAT → 127.0.0.1）"]
    end

    DNS["DNS 服务器<br/>192.168.127.1"]
    HostLoop["宿主机回环<br/>127.0.0.1"]

    GW <-->|"eth0"| VM
    VM -->|"host.boxlite.internal"| VH
    VH -->|"NAT"| HostLoop
    GW --- DNS
```

### B.3.1 地址常量

所有常量定义在 `src/boxlite/src/net/constants.rs` 中：

| 常量 | 值 | 用途 |
|------|-----|------|
| `SUBNET` | `192.168.127.0/24` | 虚拟网络范围 |
| `GATEWAY_IP` | `192.168.127.1` | gvproxy 端点，同时也是 DNS 服务器 |
| `GUEST_IP` | `192.168.127.2` | 客户机的静态租约 |
| `HOST_IP` | `192.168.127.254` | NAT 到宿主机的 `127.0.0.1` |
| `GUEST_CIDR` | `192.168.127.2/24` | 客户机中的 IP 分配 |
| `GUEST_INTERFACE` | `eth0` | virtio-net 接口名称 |
| `DEFAULT_MTU` | `1500` | 标准以太网 MTU |
| `HOST_HOSTNAME` | `host.boxlite.internal` | 虚拟宿主机的 DNS 名称 |
| `HOST_ALIAS_ZONE` | `boxlite.internal.` | DNS 区域名称 |

### B.3.2 MAC 地址管理

MAC 地址是硬编码的，必须在网络后端（DHCP 服务器）和引擎（virtio-net 设备）之间保持同步：

```
网关 MAC:   5a:94:ef:e4:0c:dd
客户机 MAC: 5a:94:ef:e4:0c:ee
                            ^^ 仅此字节不同
```

网关配置一个 DHCP 静态租约，将 `GUEST_MAC` 映射到 `GUEST_IP`，确保客户机始终获得 `192.168.127.2`。如果这些 MAC 地址不匹配，客户机将无法获得预期的 IP 地址。

## B.4 Gvisor-Tap-Vsock 后端（主要）

主要后端使用 [gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock)，与 Podman 使用的用户态网络栈相同。它被编译为 Go 库并通过 CGO/FFI 链接到 BoxLite。

### B.4.1 模块结构（Rust 端）

```
src/boxlite/src/net/
  mod.rs              # NetworkBackend trait、Factory、ConnectionType
  constants.rs        # IP/MAC/DNS 常量
  socket_path.rs      # Unix socket 路径缩短
  ca.rs               # MITM CA 证书生成
  libslirp.rs         # 备选后端
  gvproxy/
    mod.rs            # GvisorTapBackend（实现 NetworkBackend）
    config.rs         # GvproxyConfig、DnsZone、PortMapping、SecretConfig
    instance.rs       # GvproxyInstance（RAII 生命周期管理）
    ffi.rs            # 围绕原始 FFI 调用的安全封装
    logging.rs        # Go slog → Rust tracing 桥接
    stats.rs          # NetworkStats、TcpStats 反序列化
```

### B.4.2 Go 层（gvproxy-bridge）

Go 代码位于 `src/deps/libgvproxy-sys/gvproxy-bridge/` 中，编译为静态库（Unix 上为 `.a`，Windows 上为 DLL）：

| 文件 | 用途 |
|------|------|
| `main.go` | FFI 导出、实例生命周期、虚拟网络创建 |
| `forked_tcp.go` | 带 AllowNet 过滤和 SNI 检查的 TCP 转发器 |
| `forked_network.go` | 分叉的网络处理器 |
| `dns_filter.go` | DNS 黑洞过滤实现 |
| `tcp_filter.go` | TCP 级别的 IP/CIDR/主机名白名单匹配 |
| `mitm_proxy.go` | HTTPS 拦截和密钥注入 |
| `mitm_replacer.go` | 流式占位符替换 |
| `mitm_websocket.go` | 通过 MITM 的 WebSocket 升级处理 |
| `sni_peek.go` | TLS SNI 头部提取 |
| `stats.go` | 通过 VirtualNetwork 收集网络统计信息 |
| `mitm.go` | MITM CA 和证书管理 |

### B.4.3 Go-Rust FFI 桥接

```mermaid
flowchart LR
    subgraph Rust["Rust 进程"]
        direction TB
        Backend["GvisorTapBackend"]
        Instance["GvproxyInstance"]
        FFISafe["ffi.rs<br/>（安全封装）"]
        LibSys["libgvproxy-sys<br/>（extern C 声明）"]
        Tracing["tracing 订阅者"]
    end

    subgraph CGO["CGO 边界"]
        CHeader["C 头文件：<br/>gvproxy_create<br/>gvproxy_destroy<br/>gvproxy_get_stats<br/>gvproxy_set_log_callback<br/>gvproxy_get_version"]
    end

    subgraph Go["Go 运行时"]
        direction TB
        Main["main.go<br/>（导出函数）"]
        VN["VirtualNetwork<br/>（gvisor-tap-vsock）"]
        LogHook["RustTracingLogrusHook"]
    end

    Backend --> Instance
    Instance --> FFISafe
    FFISafe --> LibSys
    LibSys --> CHeader
    CHeader --> Main
    Main --> VN
    LogHook -->|"回调"| Tracing
```

**FFI 函数签名：**

```c
// 从 JSON 配置创建 gvproxy 实例。返回实例 ID 或 -1。
long long gvproxy_create(const char* configJSON);

// 按 ID 销毁实例。成功返回 0。
int gvproxy_destroy(long long id);

// 获取 JSON 格式的统计信息。调用者必须使用 gvproxy_free_string 释放。
char* gvproxy_get_stats(long long id);

// 注册 Rust 日志回调（Go → Rust 日志转发）。
void gvproxy_set_log_callback(void* callback);

// 获取版本字符串。调用者必须使用 gvproxy_free_string 释放。
char* gvproxy_get_version();

// 释放由 Go 分配的字符串。
void gvproxy_free_string(char* str);
```

### B.4.4 日志桥接

日志桥接统一了 Go 和 Rust 的日志输出。它通过 `std::sync::Once` 在首次 `GvproxyInstance::new()` 调用时初始化一次。

```mermaid
flowchart LR
    subgraph Go["Go 运行时"]
        Logrus["logrus.Info(...)"]
        Hook["RustTracingLogrusHook"]
        Writer["RustTracingWriter<br/>（标准日志重定向）"]
    end

    subgraph CGO["CGO"]
        Callback["call_rust_log_callback()"]
    end

    subgraph Rust["Rust 运行时"]
        CB["gvproxy_log_callback()"]
        Tracing["tracing::info!<br/>target: gvproxy"]
    end

    Logrus --> Hook
    Hook --> Callback
    Writer --> Callback
    Callback --> CB
    CB --> Tracing
```

**日志级别映射：**

| Go 级别 | Rust 级别 | 值 |
|---------|----------|-----|
| `logrus.TraceLevel` | `tracing::trace!` | 0 |
| `logrus.DebugLevel` | `tracing::debug!` | 1 |
| `logrus.InfoLevel` | `tracing::info!` | 2 |
| `logrus.WarnLevel` | `tracing::warn!` | 3 |
| `logrus.ErrorLevel+` | `tracing::error!` | 4 |

**控制 gvproxy 日志输出：**

```bash
# 显示 gvproxy 调试日志
RUST_LOG=gvproxy=debug cargo run

# 仅显示 gvproxy 警告和错误
RUST_LOG=gvproxy=warn cargo run
```

### B.4.5 实例生命周期

```mermaid
sequenceDiagram
    participant App as BoxLite 运行时
    participant Backend as GvisorTapBackend
    participant Instance as GvproxyInstance
    participant FFI as ffi.rs
    participant Go as Go（main.go）
    participant VN as VirtualNetwork

    App->>Backend: GvisorTapBackend::new(config)
    Backend->>Instance: GvproxyInstance::new(socket_path, ports, ...)
    Instance->>Instance: logging::init_logging()（Once）
    Instance->>FFI: create_instance(GvproxyConfig)
    FFI->>FFI: serde_json::to_string(config)
    FFI->>Go: gvproxy_create(json_c_str)
    Go->>Go: 解析 JSON 配置
    Go->>Go: 创建平台套接字（Unix/TCP）
    Go->>Go: 构建 types.Configuration
    Go->>VN: virtualnetwork.New(tapConfig)
    Go->>Go: 启动 Accept goroutine
    Go-->>FFI: instance_id
    FFI-->>Instance: id
    Instance-->>Backend: GvproxyInstance

    Note over Backend: 统计日志任务已启动（30 秒间隔）

    App->>Backend: backend.endpoint()
    Backend-->>App: NetworkBackendEndpoint::UnixSocket{...}

    Note over App: 引擎使用端点配置虚拟机

    App->>Backend: Drop
    Backend->>Instance: Drop（Arc 引用计数 → 0）
    Instance->>FFI: destroy_instance(id)
    FFI->>Go: gvproxy_destroy(id)
    Go->>Go: 取消上下文，关闭套接字
    Go-->>FFI: 0（成功）
```

### B.4.6 网络统计

统计信息通过调用 VirtualNetwork 内置的 `/stats` HTTP 处理器收集，使用 `httptest`（无需实际 HTTP 服务器）：

```rust
pub struct NetworkStats {
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub tcp: TcpStats,
}

pub struct TcpStats {
    pub forward_max_inflight_drop: u64,  // 关键：SYN 丢弃
    pub current_established: u64,
    pub failed_connection_attempts: u64,
    pub retransmits: u64,
    pub timeouts: u64,
}
```

一个后台 Tokio 任务每 30 秒记录一次统计信息。它持有一个 `Weak<GvproxyInstance>` 引用，因此日志任务不会使实例保持存活。

## B.5 端口转发

### B.5.1 端口映射来源

端口映射来自两个来源（用户提供的优先）：

1. **用户提供** -- 在 `BoxOptions` 中显式指定
2. **镜像暴露** -- 从 OCI 镜像清单（manifest）的 `ExposedPorts` 中提取，1:1 映射（仅在用户未覆盖时使用）

### B.5.2 转发流程

```mermaid
sequenceDiagram
    participant User as 用户配置
    participant RT as BoxLite 运行时
    participant Config as GvproxyConfig
    participant Go as Go（gvproxy）
    participant VN as VirtualNetwork
    participant Guest as 客户机 :80

    User->>RT: port_mappings: [(8080, 80)]
    RT->>Config: GvproxyConfig::new(socket, [(8080, 80)])
    Config->>Config: PortMapping { host: 8080, guest: 80 }
    RT->>Go: gvproxy_create(json)
    Go->>Go: tapConfig.Forwards["0.0.0.0:8080"] = "192.168.127.2:80"
    Go->>VN: virtualnetwork.New(tapConfig)
    VN->>VN: 在 0.0.0.0:8080（宿主机）上监听

    Note over VN,Guest: 当流量到达宿主机 :8080 时

    VN->>VN: 在 :8080 上接受连接
    VN->>Guest: 转发到 192.168.127.2:80
    Guest-->>VN: 响应
    VN-->>VN: 转发回调用方
```

**重要提示：** Go 中的转发格式为 `"0.0.0.0:{host_port}" → "{guest_ip}:{guest_port}"`。不能使用 `tcp://` 前缀（否则会导致 "too many colons in address" 错误）。

## B.6 DNS 解析

### B.6.1 内置 DNS

gvproxy 在 `192.168.127.1:53` 上运行一个嵌入式 DNS 服务器。它提供以下服务：

1. **内置区域** -- `boxlite.internal.` 区域包含一条 A 记录：`host` -> `192.168.127.254`
2. **用户定义区域** -- 通过配置添加的自定义 `DnsZone` 条目
3. **转发查询** -- 任何不匹配本地区域的查询被转发到宿主机系统 DNS 解析器

```mermaid
flowchart TB
    Guest["客户机 DNS 查询<br/>例如 host.boxlite.internal"]
    DNS["嵌入式 DNS<br/>192.168.127.1:53"]

    subgraph Zones["区域匹配（先匹配先生效）"]
        Z1["boxlite.internal.<br/>host → 192.168.127.254"]
        Z2["用户区域<br/>（如果已配置）"]
        Z3["黑洞过滤区域<br/>（如果 allow_net 生效）"]
        ZCatch["兜底根区域<br/>→ 0.0.0.0<br/>（仅黑洞过滤模式）"]
    end

    Forward["宿主机系统 DNS<br/>（上游解析器）"]
    Result["DNS 响应"]

    Guest --> DNS
    DNS --> Z1
    Z1 -->|"匹配"| Result
    Z1 -->|"未匹配"| Z2
    Z2 -->|"匹配"| Result
    Z2 -->|"未匹配"| Z3
    Z3 -->|"匹配（黑洞过滤）"| Result
    Z3 -->|"未匹配"| ZCatch
    ZCatch -->|"黑洞过滤生效"| Result
    Z2 -->|"无黑洞过滤"| Forward
    Forward --> Result
```

### B.6.2 DnsZone 配置

```rust
pub struct DnsZone {
    pub name: String,              // 区域名称，例如 "boxlite.internal."
    pub records: Vec<DnsRecord>,   // 精确 A 记录
    pub default_ip: String,        // 未匹配记录的默认 IP（空 = 仅精确匹配）
}

pub struct DnsRecord {
    pub name: String,  // 区域内的记录标签，例如 "host"
    pub ip: String,    // IPv4 地址
}
```

### B.6.3 DNS 黑洞过滤（allow_net）

当 `allow_net` 非空时，黑洞过滤器阻止对非白名单主机的 DNS 解析：

```mermaid
flowchart TB
    Config["allow_net: [api.openai.com, *.github.com]"]

    subgraph Build["buildAllowNetDNSZones()"]
        direction TB
        Resolve["解析允许的主机名<br/>→ A 记录"]
        ExactZone["区域: openai.com.<br/>记录: api → 解析后的 IP"]
        WildZone["区域: github.com.<br/>正则: .* （匹配所有子域名）"]
        CatchAll["根区域: （空）<br/>DefaultIP: 0.0.0.0"]
    end

    Config --> Build
    Resolve --> ExactZone
    Resolve --> WildZone
    Build --> CatchAll

    subgraph Runtime["DNS 查询解析"]
        Q1["api.openai.com?<br/>→ 匹配区域，返回真实 IP"]
        Q2["sub.github.com?<br/>→ 匹配通配符，返回真实 IP"]
        Q3["evil.example.com?<br/>→ 无匹配 → 兜底 → 0.0.0.0"]
    end
```

**关键行为：**
- `host.boxlite.internal` 始终被允许（内置区域优先）
- `allow_net` 中的 IP 地址和 CIDR 由 TCP 级别过滤处理，而非 DNS
- 主机名在过滤器创建时被解析并缓存为 A 记录
- 一个 `0.0.0.0` 的兜底根区域会将所有未显式允许的请求导入黑洞

### B.6.4 TCP 级别过滤

除了 DNS 黑洞过滤外，`TCPFilter` 在连接级别运行：

```rust
// 支持的规则类型：
// - 精确 IP: "1.2.3.4"
// - CIDR: "10.0.0.0/8"
// - 精确主机名: "api.openai.com"（通过 SNI/Host 头检查）
// - 通配符: "*.example.com"（后缀匹配）
```

对于端口 443 和 80，转发器会窥探 TLS SNI（端口 443）或 HTTP Host 头（端口 80）以确定目标主机名，然后在转发前与白名单进行比对。

内部 IP（网关、客户机、虚拟宿主机）始终被允许。

## B.7 MITM 代理和密钥注入

MITM（中间人）代理允许 BoxLite 将密钥（如 API 密钥）注入到出站 HTTP/HTTPS 请求中，而无需在客户机虚拟机内部暴露它们。

### B.7.1 密钥配置

```rust
pub struct Secret {
    pub name: String,           // 例如 "openai"
    pub hosts: Vec<String>,     // 例如 ["api.openai.com"]
    pub placeholder: String,    // 例如 "<BOXLITE_SECRET:openai>"
    pub value: String,          // 例如 "sk-actual-key-value"
}
```

客户机代码在请求中使用占位符字符串。MITM 代理在请求离开宿主机之前，透明地将占位符替换为实际的密钥值。

### B.7.2 MITM 流程

```mermaid
sequenceDiagram
    participant Guest as 客户机容器
    participant GVP as gvproxy（Go）
    participant CA as BoxCA
    participant Upstream as api.openai.com

    Note over Guest,GVP: 客户机信任库中已有 MITM CA 证书

    Guest->>GVP: HTTPS 请求到 api.openai.com<br/>Authorization: Bearer <BOXLITE_SECRET:openai>

    GVP->>GVP: SNI 窥探 → "api.openai.com"
    GVP->>GVP: SecretHostMatcher → 发现密钥

    GVP->>CA: GenerateHostCert("api.openai.com")
    CA-->>GVP: api.openai.com 的 TLS 证书

    GVP->>GVP: TLS 终止客户机连接<br/>（使用生成的证书）

    GVP->>GVP: substituteHeaders(req, secrets)<br/>替换占位符 → 真实密钥

    GVP->>GVP: secretTransport.RoundTrip()<br/>替换请求体中的占位符

    GVP->>Upstream: 带真实 API 密钥的 HTTPS 请求
    Upstream-->>GVP: 响应
    GVP-->>Guest: 响应（未修改）
```

### B.7.3 CA 证书管理

```rust
// Rust 端: src/boxlite/src/net/ca.rs
pub struct MitmCa {
    pub cert_pem: String,
    pub key_pem: String,
}

// 生成: ECDSA P-256, 24 小时有效期, 自签名
// 持久化: {box_dir}/ca/cert.pem (0644), key.pem (0600)
// 重启时重新加载以维护客户机信任库一致性
pub fn load_or_generate(ca_dir: &Path) -> BoxliteResult<MitmCa>
```

CA 证书的处理流程：
1. 由 Rust 使用 `rcgen` 生成（ECDSA P-256，24 小时有效期）
2. 持久化到 `{box_dir}/ca/` 以确保重启一致性
3. 通过 JSON 配置传递给 Go（`ca_cert_pem`、`ca_key_pem`）
4. 在容器初始化期间注入到客户机的信任库中

### B.7.4 WebSocket 支持

通过 MITM 拦截的主机支持 WebSocket 连接：
- 通过 `Connection: upgrade` + `Upgrade: websocket` 头检测升级请求
- 密钥替换仅应用于请求头
- 在 101 握手之后，帧被双向中继且不做修改
- 这是设计选择：WebSocket 帧可能被任意分片，使得可靠的请求体替换变得不切实际

## B.8 引擎集成

### B.8.1 Virtio-Net 特性标志

引擎使用以下特性标志配置虚拟机的 virtio-net 设备（定义在 `src/boxlite/src/vmm/krun/constants.rs` 中）：

| 标志 | 位 | 描述 |
|------|-----|------|
| `NET_FEATURE_CSUM` | 0 | 部分校验和卸载 |
| `NET_FEATURE_GUEST_CSUM` | 1 | 客户机处理部分校验和 |
| `NET_FEATURE_GUEST_TSO4` | 7 | 客户机可接收 TSOv4 |
| `NET_FEATURE_GUEST_UFO` | 10 | 客户机可接收 UFO |
| `NET_FEATURE_HOST_TSO4` | 11 | 宿主机可接收 TSOv4 |
| `NET_FEATURE_HOST_UFO` | 14 | 宿主机可接收 UFO |
| `NET_FLAG_VFKIT` | 0 | 发送 VFKit 魔术握手（仅 macOS） |

### B.8.2 平台分发

```mermaid
flowchart TB
    Endpoint["NetworkBackendEndpoint::UnixSocket"]
    ConnType{"ConnectionType?"}

    Linux["krun_add_net_unixstream()<br/>path, fd=-1, mac, features, flags=0"]
    Mac["krun_add_net_unixgram()<br/>path, fd=-1, mac, features, flags=NET_FLAG_VFKIT"]
    Win["krun_add_net()<br/>tcp://127.0.0.1:port, mac"]

    Endpoint --> ConnType
    ConnType -->|UnixStream| Linux
    ConnType -->|UnixDgram| Mac
    ConnType -->|Windows| Win
```

引擎中的平台特定行为（`vmm/krun/context.rs`）：

- **Linux:** `krun_add_net_unixstream(ctx, path, -1, mac, features, 0)` -- SOCK_STREAM，Qemu 协议
- **macOS:** `krun_add_net_unixgram(ctx, path, -1, mac, features, NET_FLAG_VFKIT)` -- SOCK_DGRAM，带魔术握手的 VFKit 协议
- **Windows:** `krun_add_net(ctx, endpoint, mac)` -- TCP 端点字符串

### B.8.3 平台套接字创建（Go 端）

```mermaid
flowchart TB
    Config["GvproxyConfig"]
    HasListenAddr{"listen_addr 是否设置?"}

    TCP["net.Listen('tcp', addr)<br/>Qemu 协议"]
    IsDarwin{"runtime.GOOS == 'darwin'?"}
    UnixDgram["transport.ListenUnixgram()<br/>VFKit 协议"]
    UnixStream["net.Listen('unix', path)<br/>Qemu 协议"]

    Config --> HasListenAddr
    HasListenAddr -->|"是（Windows）"| TCP
    HasListenAddr -->|"否"| IsDarwin
    IsDarwin -->|"是"| UnixDgram
    IsDarwin -->|"否（Linux）"| UnixStream
```

## B.9 客户机网络配置

虚拟机启动后，宿主机发送一个包含网络配置的 `Guest.Init` RPC：

```rust
// 通过 vsock 上的 gRPC 从宿主机发送到客户机
NetworkInitConfig {
    interface: "eth0",           // GUEST_INTERFACE
    ip: Some("192.168.127.2/24"), // GUEST_CIDR
    gateway: Some("192.168.127.1"), // GATEWAY_IP
}
```

客户机代理使用 `rtnetlink`（纯 Rust netlink 库，不依赖 `ip` 命令）配置网络：

1. 启动 `lo` 回环接口
2. 查找 `eth0` 接口（由 virtio-net 创建）
3. 启动 `eth0`
4. 分配 IP 地址 `192.168.127.2/24`
5. 添加通过 `192.168.127.1` 的默认路由
6. 验证配置（调试模式）

## B.10 套接字路径缩短

### B.10.1 问题

Unix 域套接字有一个 `sun_path` 缓冲区长度限制：
- **macOS:** 104 字节
- **Linux:** 108 字节

BoxLite 的套接字路径（如 `~/.boxlite/boxes/{box_id}/sockets/net.sock`）可能超过此限制。

### B.10.2 解决方案

在 `/tmp` 中创建一个短符号链接，指向真实的套接字目录：

```
/tmp/bl_{short_id}  →  ~/.boxlite/boxes/{box_id}/sockets/
```

内核在 VFS 路径查找期间解析符号链接，这发生在 `sun_path` 长度检查之后，因此短符号链接路径满足缓冲区约束，而套接字文件物理上位于真实（长）路径。

```mermaid
flowchart LR
    subgraph ShortPath["短路径（< 104 字节）"]
        Symlink["/tmp/bl_aB3xK9Lm/net.sock"]
    end

    subgraph RealPath["真实路径（可能超过 104 字节）"]
        Real["~/.boxlite/boxes/abc123def456.../sockets/net.sock"]
    end

    Symlink -->|"符号链接"| Real

    Bind["bind() 使用短路径"]
    Kernel["内核解析符号链接<br/>在 sun_path 检查之后"]

    Bind --> Symlink
    Symlink --> Kernel
    Kernel --> Real
```

### B.10.3 实现细节

```rust
pub struct SocketShortener {
    symlink_path: PathBuf,  // /tmp/bl_{short_id}
    real_dir: PathBuf,      // ~/.boxlite/boxes/{id}/sockets/
}

impl SocketShortener {
    // 如果路径已经足够短或在 Windows 上，返回 Ok(None)
    pub fn new(short_id: &str, sockets_dir: &Path) -> BoxliteResult<Option<Self>>;

    // 获取套接字文件的短路径
    pub fn short_path(&self, socket_name: &str) -> PathBuf;
}

impl Drop for SocketShortener {
    fn drop(&mut self) { /* 移除符号链接 */ }
}
```

**过期符号链接清理：** `cleanup_stale_symlinks()` 在运行时启动时执行，移除目标已不存在的 `/tmp/bl_*` 符号链接（由崩溃的进程遗留）。

**库安全性：** BoxLite 是一个库 -- 它从不更改宿主机进程的当前工作目录（CWD）。符号链接方法避免了任何进程全局状态的变更。

**Windows：** `SocketShortener::new()` 始终返回 `Ok(None)` -- Windows 上的 AF_UNIX 没有相同的路径长度限制，且 Windows 通常使用 TCP 端口替代。

## B.11 平台差异

```mermaid
flowchart TB
    subgraph Linux["Linux"]
        L1["UnixStream（SOCK_STREAM）"]
        L2["Qemu 协议"]
        L3["krun_add_net_unixstream()"]
        L4["静态库 .a"]
        L5["链接: glibc, libresolv"]
    end

    subgraph macOS["macOS"]
        M1["UnixDgram（SOCK_DGRAM）"]
        M2["VFKit 协议 + 魔术握手"]
        M3["krun_add_net_unixgram()"]
        M4["静态库 .a"]
        M5["链接: CoreFoundation, Security"]
    end

    subgraph Windows["Windows"]
        W1["TCP 端口（127.0.0.1:0）"]
        W2["Qemu over TCP"]
        W3["krun_add_net()"]
        W4["DLL（c-shared）"]
        W5["动态链接"]
    end
```

### B.11.1 详细对比

| 方面 | Linux | macOS | Windows |
|------|-------|-------|---------|
| **连接类型** | `UnixStream`（SOCK_STREAM） | `UnixDgram`（SOCK_DGRAM） | TCP 端口 |
| **线路协议** | Qemu（长度前缀） | VFKit（魔术握手） | Qemu over TCP |
| **libgvproxy 构建** | 静态归档（`.a`） | 静态归档（`.a`） | DLL（c-shared） |
| **系统库** | glibc, libresolv | CoreFoundation, Security | 动态 |
| **套接字创建** | `net.Listen("unix", path)` | `transport.ListenUnixgram(uri)` | `net.Listen("tcp", addr)` |
| **libkrun FFI** | `krun_add_net_unixstream()` | `krun_add_net_unixgram()` | `krun_add_net()` |
| **端口分配** | 不适用（确定性路径） | 不适用（确定性路径） | `allocate_port()` 绑定 `127.0.0.1:0` |
| **套接字缩短** | 需要时使用符号链接 | 需要时使用符号链接 | 无操作 |

### B.11.2 Windows TCP 端口分配

在 Windows 上，Unix 套接字不可用。每个 box 分配三个临时 TCP 端口：

```rust
pub struct BoxPorts {
    pub grpc_port: u16,   // gRPC 传输（宿主机 <-> 客户机）
    pub ready_port: u16,  // 就绪信号
    pub net_port: u16,    // 网络后端流量
}

pub fn allocate_port() -> BoxliteResult<u16> {
    // 绑定 127.0.0.1:0，读取操作系统分配的端口，释放监听器
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}
```

端口分配和后续绑定之间存在的微小 TOCTOU（检查时间/使用时间）窗口是可以接受的，因为临时端口池很大（约 16k 个端口）。

## B.12 网络故障与调试

### B.12.1 关键指标

| 指标 | 正常值 | 告警条件 | 含义 |
|------|--------|----------|------|
| `tcp.forward_max_inflight_drop` | 0 | > 0 | SYN 包因并发连接限制被丢弃（默认 `maxInFlight=10`） |
| `bytes_received` | 约 30 秒后 > 0 | 30 秒后仍为 0 | 网络后端未初始化或客户机未配置 |
| `tcp.failed_connection_attempts` | 低 | 快速增加 | DNS 解析失败、路由问题或黑洞过滤阻断 |
| `tcp.retransmits` | 低 | 相对于数据段偏高 | 网络拥塞或丢包 |
| `tcp.timeouts` | 0 | > 0 | RTO（重传超时）事件 -- 严重拥塞 |
| `tcp.current_established` | 与预期一致 | 意外为 0 | 所有连接已断开或失败 |

### B.12.2 调试工具

**启用调试日志：**

```bash
# 所有 gvproxy 日志
RUST_LOG=gvproxy=debug python my_script.py

# 抓包到 pcap 文件
BOXLITE_NET_CAPTURE_FILE=/tmp/capture.pcap python my_script.py
# 然后使用 Wireshark 分析
```

**以编程方式检查统计信息：**

```rust
let backend = GvisorTapBackend::new(config)?;
let stats = backend.get_stats()?;

if stats.tcp.forward_max_inflight_drop > 0 {
    warn!("TCP 连接被丢弃: {}", stats.tcp.forward_max_inflight_drop);
}
```

### B.12.3 常见问题

**box 启动后没有连接：**
- gvproxy 需要大约 30 秒才能完全初始化虚拟网络
- `bytes_received = 0` 指标确认网络尚未就绪
- 统计日志任务在首次检查前等待 30 秒正是出于这个原因

**客户机内部 DNS 解析失败：**
- 如果 DNS 黑洞过滤处于活动状态，请验证 `allow_net` 配置
- 检查 `host.boxlite.internal` 是否正确解析（始终被允许）
- DNS 服务器在 `192.168.127.1`（与网关相同）

**端口转发不工作：**
- 确认容器在客户机内部绑定到 `0.0.0.0`（而非 `127.0.0.1`）
- 端口转发目标是 `192.168.127.2:{guest_port}`，而非 localhost
- 检查宿主机端是否存在端口冲突

**套接字路径过长：**
- macOS 限制为 104 字节，Linux 限制为 108 字节
- `SocketShortener` 自动处理此问题
- 如果临时目录本身路径过长，将返回明确的错误信息

## B.13 数据路径（端到端）

```mermaid
flowchart TB
    subgraph Inbound["入站：宿主机 → 客户机"]
        HA["宿主机应用<br/>连接到 localhost:8080"]
        HK["宿主机操作系统内核"]
        GVP_IN["gvproxy<br/>（Unix socket 监听）"]
        PF["端口转发规则<br/>8080 → 80"]
        TAP_IN["TAP 设备<br/>（宿主机端）"]
        SOCK_IN["Unix socket 桥接"]
        KRUN_IN["libkrun<br/>virtio-net"]
        ETH_IN["客户机 eth0<br/>192.168.127.2"]
        PROC_IN["容器 :80"]
    end

    HA --> HK --> GVP_IN --> PF --> TAP_IN --> SOCK_IN --> KRUN_IN --> ETH_IN --> PROC_IN

    subgraph Outbound["出站：客户机 → 互联网"]
        PROC_OUT["容器<br/>curl https://api.example.com"]
        ETH_OUT["客户机 eth0"]
        KRUN_OUT["libkrun<br/>virtio-net"]
        SOCK_OUT["Unix socket 桥接"]
        GVP_OUT["gvproxy<br/>（用户态 TCP/IP）"]
        MITM{"MITM<br/>拦截?"}
        DIRECT["直接转发"]
        PROXY["MITM 代理<br/>（密钥注入）"]
        INTERNET["互联网"]
    end

    PROC_OUT --> ETH_OUT --> KRUN_OUT --> SOCK_OUT --> GVP_OUT --> MITM
    MITM -->|"该主机无密钥"| DIRECT --> INTERNET
    MITM -->|"已配置密钥"| PROXY --> INTERNET
```

## B.14 配置参考

### B.14.1 GvproxyConfig（完整 JSON）

以下是通过 `gvproxy_create()` 从 Rust 传递给 Go 的 JSON 结构：

```json
{
  "socket_path": "/home/user/.boxlite/boxes/my-box/sockets/net.sock",
  "subnet": "192.168.127.0/24",
  "gateway_ip": "192.168.127.1",
  "gateway_mac": "5a:94:ef:e4:0c:dd",
  "guest_ip": "192.168.127.2",
  "host_ip": "192.168.127.254",
  "guest_mac": "5a:94:ef:e4:0c:ee",
  "mtu": 1500,
  "port_mappings": [
    { "host_port": 8080, "guest_port": 80 },
    { "host_port": 8443, "guest_port": 443 }
  ],
  "dns_zones": [
    {
      "name": "boxlite.internal.",
      "records": [{ "name": "host", "ip": "192.168.127.254" }],
      "default_ip": ""
    }
  ],
  "dns_search_domains": ["local"],
  "debug": false,
  "allow_net": ["api.openai.com", "*.github.com"],
  "secrets": [
    {
      "name": "openai",
      "hosts": ["api.openai.com"],
      "placeholder": "<BOXLITE_SECRET:openai>",
      "value": "sk-actual-key-value"
    }
  ],
  "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "ca_key_pem": "-----BEGIN PRIVATE KEY-----\n..."
}
```

### B.14.2 环境变量

| 变量 | 用途 | 示例 |
|------|------|------|
| `RUST_LOG` | 控制日志详细程度 | `RUST_LOG=gvproxy=debug` |
| `BOXLITE_NET_CAPTURE_FILE` | 启用 pcap 抓包 | `/tmp/capture.pcap` |

## B.15 源文件参考

| 文件 | 用途 |
|------|------|
| `src/boxlite/src/net/mod.rs` | `NetworkBackend` trait、`NetworkBackendFactory`、类型定义 |
| `src/boxlite/src/net/constants.rs` | IP、MAC、DNS、MTU 常量 |
| `src/boxlite/src/net/socket_path.rs` | 用于 Unix `sun_path` 限制的 `SocketShortener` |
| `src/boxlite/src/net/ca.rs` | MITM CA 证书生成（ECDSA P-256） |
| `src/boxlite/src/net/libslirp.rs` | 备选 `LibslirpBackend` |
| `src/boxlite/src/net/gvproxy/mod.rs` | `GvisorTapBackend` 实现 |
| `src/boxlite/src/net/gvproxy/config.rs` | `GvproxyConfig`、`DnsZone`、`PortMapping` |
| `src/boxlite/src/net/gvproxy/instance.rs` | `GvproxyInstance` 生命周期 + 统计日志 |
| `src/boxlite/src/net/gvproxy/ffi.rs` | 安全 FFI 封装 |
| `src/boxlite/src/net/gvproxy/logging.rs` | Go 到 Rust 的日志桥接 |
| `src/boxlite/src/net/gvproxy/stats.rs` | `NetworkStats`、`TcpStats` |
| `src/boxlite/src/net/port.rs` | Windows TCP 端口分配 |
| `src/boxlite/src/vmm/krun/constants.rs` | virtio-net 特性标志 |
| `src/boxlite/src/vmm/krun/context.rs` | 引擎网络设置（`add_net_*`） |
| `src/boxlite/src/litebox/init/tasks/guest_init.rs` | 客户机网络初始化 RPC |
| `src/guest/src/network.rs` | 客户机端 `eth0` 配置（rtnetlink） |
| `src/deps/libgvproxy-sys/src/lib.rs` | 原始 FFI 声明 |
| `src/deps/libgvproxy-sys/gvproxy-bridge/main.go` | Go FFI 导出、实例管理 |
| `src/deps/libgvproxy-sys/gvproxy-bridge/dns_filter.go` | DNS 黑洞过滤 |
| `src/deps/libgvproxy-sys/gvproxy-bridge/tcp_filter.go` | TCP 白名单 |
| `src/deps/libgvproxy-sys/gvproxy-bridge/forked_tcp.go` | 带过滤的 TCP 转发器 |
| `src/deps/libgvproxy-sys/gvproxy-bridge/mitm_proxy.go` | HTTPS MITM + 密钥替换 |
| `src/deps/libgvproxy-sys/gvproxy-bridge/mitm_replacer.go` | 流式占位符替换 |
| `src/deps/libgvproxy-sys/gvproxy-bridge/mitm_websocket.go` | 通过 MITM 的 WebSocket |
| `src/deps/libgvproxy-sys/gvproxy-bridge/sni_peek.go` | TLS SNI 提取 |
| `src/deps/libgvproxy-sys/gvproxy-bridge/stats.go` | 统计信息收集 |
