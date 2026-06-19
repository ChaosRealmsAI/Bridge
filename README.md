# Panda Bridge

Panda Bridge 是通用的 Cloud-to-Local Secure Relay / Jump Host。

它让产品通过我们提供的 Bridge Cloud 连接用户自己的电脑。Bridge core 只做账号设备接入、presence、短期密文信封中转、ack/status 和资源状态；具体业务能力由 Product Adapter 处理。

```text
Product App
  -> @panda-bridge/sdk
  -> Panda Bridge Cloud
  -> Panda Bridge Desktop
  -> Product Adapter
  -> encrypted response envelope
  -> Product App
```

## 核心边界

- Bridge Cloud 不执行 Claude、Codex、Burn、shell、fs 或 data 业务。
- Bridge Desktop core 不解密业务内容，不理解命令，不持有产品会话密钥。
- Product App 和本机 Product Adapter 负责端到端加密、业务协议和本机权限策略。
- 服务器只短期保存 `ciphertext/aad/nonce/key ids/channel/seq/status` 等路由数据。
- 旧 runtime job API 已迁出；调用会返回 `legacy_runtime_api_removed`。

## 组件

```text
apps/cloud-worker      Bridge Cloud Worker
apps/web-chat          本地/网页测试入口
apps/desktop           tao + wry 桌面壳，负责设备、授权、presence、AdapterRouter
packages/protocol      Relay Envelope Protocol
packages/sdk           @panda-bridge/sdk
examples/relay-local-control
                       极小 Product Adapter 样板，证明 pwd/ls 可经 relay 控制本机
supabase/migrations    Bridge Cloud 表结构
```

## 桌面端打包

macOS 打包仍走现有 `.app` / `.dmg` 路线：

```bash
npm run desktop:package:mac
```

Windows 桌面端沿用同一套 Rust + wry + HTML UI，依赖 Microsoft Edge WebView2 Evergreen Runtime。Windows 包是当前用户级 portable zip，安装脚本会复制到 `%LOCALAPPDATA%\Panda Bridge`，注册 `panda-bridge://`，并写入 HKCU Run 开机启动；如果 WebView2 runtime 缺失，安装脚本会打印下载提示：

```bash
npm run desktop:package:windows
```

没有 Windows runtime 时，使用交叉目标和安装契约检查：

```bash
npm run verify:desktop-windows
```

需要在 macOS/Linux 上进一步生成真实 Windows MSVC exe 和 portable zip 时，先安装 `cargo-xwin`，并确保系统有 `zip` CLI，再运行：

```bash
npm run verify:desktop-windows:xwin
npm run desktop:package:windows:xwin
```

仓库接入 GitHub Actions 后，`.github/workflows/windows-desktop.yml` 会在 `windows-latest` 上运行同一验证、构建 portable zip，执行 `Install.ps1 -NoLaunch` 检查 HKCU deep link/自启注册和卸载清理，并上传 Windows 桌面 artifact。

## 服务器选择

默认给用户使用我们提供的 Bridge Cloud，用户不需要自建服务器。

桌面端也支持用户自己维护 Bridge Cloud。用户可以在设置里添加自托管 API，Desktop 会通过 `/v1/health` 和 `/v1/diagnostics` 验证服务器；左侧产品列表仍来自固定 Panda 产品目录，服务器 Profile 只决定授权、presence 和 relay 使用哪个 Bridge API。自托管部署和本机 Adapter 配置见 [`docs/self-hosting.md`](docs/self-hosting.md)。

官方托管资源：

```text
API:    https://api.bridge.chaos-realms.cc
Web:    https://bridge.chaos-realms.cc
Assets: https://assets.bridge.chaos-realms.cc
```

测试托管资源：

```text
API:    https://api-bridge-test.chaos-realms.cc
Web:    https://bridge-test.chaos-realms.cc
Assets: https://assets-bridge-test.chaos-realms.cc
```

## 本机控制样板

`examples/relay-local-control` 是当前最小可运行证明：

- Product 端把 `{ op: "pwd" }` 或 `{ op: "ls", path: "." }` 加密进 relay envelope。
- Bridge Cloud 和 Desktop Bridge core 只能看到密文和路由元数据。
- Desktop Bridge 通过 `PANDA_BRIDGE_ADAPTER_<PRODUCT>_URL` 把 opaque envelope 交给本机 HTTP Adapter。
- Adapter 解密后只执行 allowlist 中的 `pwd` 和 `ls .`，再返回加密 response envelope。

运行：

```bash
npm run verify:relay-local-control
npm run verify:relay-local-control:blackbox
```

这个示例不是通用 shell runner，不能移进 Bridge core。

## 本地开发与验证

```bash
npm install
npm run check
npm run check:relay-boundary
npm run verify:relay-backpressure
npm run check:e2ee
npm run verify:relay-local-control
npm run verify:relay-local-control:blackbox
npm run verify:selfhost-profile
npm run verify:desktop-windows
npm run verify:desktop-windows:xwin
```

常用开发入口：

```bash
npm run cloud:dev
npm run desktop:dev
npm run verify:minimal-caller
```

公开仓只保留通用源码、示例和脱敏文档。内部验证证据、PandaCode 运行记录和真实部署配置不进入 Git；部署前从私有配置复制 `apps/cloud-worker/wrangler.toml`。

先读：

```text
spec/README.md
spec/L1/产品能力.md
spec/L2/Bridge核心边界.md
spec/L2/ManagedAdapter.md
spec/L2/接口与协议.md
spec/L3/versions/agent-usage-ledger/版本合同.md
```
