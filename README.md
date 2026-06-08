# Panda Bridge

Panda Bridge 是通用的 Cloud-to-Local AI Runtime Bridge。

它让任意 SaaS 可以通过认证后的 JSON job 调用用户本机的 Codex app-server，并把执行结果和流式事件回传给 SaaS。

## 一句话

SaaS 负责派任务，Bridge Cloud 负责中转和审计，Bridge Desktop 负责本机授权和执行，Codex 负责真正干活。

```text
SaaS / Product
  -> @panda/bridge SDK
  -> Panda Bridge Cloud
  -> Panda Bridge Desktop
  -> local Codex app-server
  -> stream events / final result
  -> SaaS / Product
```

## 最终产品组成

Panda Bridge 是一个产品，不拆成 Bridge 和 Cloud 两个产品品牌。

```text
Panda Bridge
  - Panda Bridge Desktop
  - Panda Bridge Cloud
  - @panda/bridge SDK
  - Bridge Job Protocol
```

1. Panda Bridge Desktop
   - 用户本机安装的桌面端。
   - 负责设备绑定、产品授权、本机 runtime 调度、审计日志。
   - 当前采用 Rust `tao + wry` 轻量桌面壳，不使用 Tauri。

2. Panda Bridge Cloud
   - 由我们提供的云端中转服务。
   - 负责账号、设备在线、产品注册、授权记录、job 队列、events、结果存储。

3. @panda/bridge SDK
   - 给业务 SaaS 使用。
   - 负责创建 job、查询状态、订阅流式结果。

## 关键结论

Bridge Desktop 需要本地安装。

如果 SaaS 页面和 Codex 执行机器不在同一台电脑上，就必须有 Bridge Cloud 中转。用户不需要自己部署服务器，Bridge Cloud 由我们的 SaaS 平台提供。

纯本地安装也可以做 local-only 模式，但只能服务同机浏览器或本地 API，不能实现“手机/另一台电脑上的 SaaS 调用家里 Mac 上的 Codex”。

## 能力边界

Bridge 全链只做认证、授权关系检查和透明转发。SaaS 决定要发什么
`kind`、`policy`、`workspace_ref` 和 payload；Bridge 不做 kind 白名单、
策略默认注入、额度上限或 workspace 改写。

授权表示某个 product 可以连接并使用这台设备，不表示 Bridge Cloud 或 SDK
会替 SaaS 裁剪能力。

## Spec

本仓库的文档事实源已经切到新版 spec 模式。先读：

- [spec 使用说明](spec/README.md)
- [全局能力清单](spec/gate/capability-map.html)
- [当前产品路线](spec/gate/routes/v4-queue-performance-observability.md)
- [架构总览](spec/architecture/architecture.md)
- [质量门禁](spec/quality/gates.md)

## 当前实现

当前仓库已经开始落地为独立 monorepo：

```text
apps/cloud-worker      Bridge Cloud Worker
apps/web-chat          手机/浏览器聊天入口
apps/desktop           tao + wry 轻量桌面端
apps/connector-cli     本机 Connector CLI
packages/protocol      Bridge JSON 协议
packages/sdk           @panda-bridge/sdk
supabase/migrations    Bridge Cloud 表结构
```

用户主流程：

```text
浏览器 / 手机打开 https://bridge.otherline.cc
  -> 点击连接本机
  -> Panda Bridge Desktop 被深链打开
  -> 用户在桌面端确认授权
  -> 手机或浏览器创建 job
  -> 本机桌面端调用 Codex app-server
  -> 网页看到流式事件和最终回复
```

本地验证：

```bash
npm install
npm run build:web
npm run check
npm run verify:spec
npm run verify:local
npm run verify:desktop-lite
```

调用前诊断：

```bash
curl https://bridge.otherline.cc/v1/diagnostics
node apps/connector-cli/src/cli.mjs doctor --api http://127.0.0.1:8787 --state ~/.panda-bridge/connector.json --fake-codex
```

SDK 调用方可在创建 job 前执行：

```js
const diagnostics = await bridge.diagnostics();
```

队列和性能可观察性：

```js
const queueSummary = await bridge.queue.summary();
console.log(queueSummary.counts, queueSummary.devices, queueSummary.timing);
```

请求安全边界：

```text
Cloud JSON write endpoints reject oversized bodies, malformed JSON, and non-JSON content types with stable redacted errors.
SDK request errors expose status and payload for product callers.
```

Windows Desktop 构建和运行：

```powershell
cd apps\desktop
rustup target add x86_64-pc-windows-msvc
cargo build
target\debug\panda-bridge-desktop.exe
```

Windows 首次正常启动会自动注册 `panda-bridge://` 到当前用户注册表：

```text
HKCU\Software\Classes\panda-bridge
  (Default) = URL:Panda Bridge Protocol
  URL Protocol = ""
  shell\open\command = "<exe>" "%1"
```

手动核对：

```powershell
reg query HKCU\Software\Classes\panda-bridge /s
start "" "panda-bridge://connect?intent=demo&api=https%3A%2F%2Fapi.bridge.otherline.cc"
```

如果 Panda Bridge Desktop 已在运行，Windows 再次通过 `panda-bridge://` 唤起的新进程会把 URL 转发给已运行实例并退出；连接授权仍走桌面端现有确认流程。最终窗口启动、deep link 唤起、注册表写入、mica/acrylic 效果和 Credential Manager 持久化需要在 Windows 机器或 Windows CI runner 上确认。

生产部署：

```text
https://bridge.otherline.cc
https://api.bridge.otherline.cc
https://assets.bridge.otherline.cc
```

Web Chat 默认同源调用 API，也可以显式指定 API 子域：

```text
Web: https://bridge.otherline.cc
API: https://bridge.otherline.cc/v1
API: https://api.bridge.otherline.cc/v1
```

生产验证：

```bash
PANDA_BRIDGE_API_BASE=https://bridge.otherline.cc npm run verify:cloud
PANDA_BRIDGE_API_BASE=https://api.bridge.otherline.cc npm run verify:cloud
npm run verify:browser
npm run verify:mobile-browser
```

已通过的验证：

```text
npm run check
npm run verify:local
npm run verify:desktop-lite
PANDA_BRIDGE_API_BASE=https://api.bridge.otherline.cc npm run verify:cloud
npm run verify:browser
npm run verify:mobile-browser
```

本版 spec/代码对齐的证据输出：

```text
spec/verification/evidence/v4-queue-performance-observability/spec-traceability-summary.json
spec/verification/v4-queue-performance-observability.html
```
