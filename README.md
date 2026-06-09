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

## 产品化接入文档

- [调用方产品接入指南](docs/product-integration.md)
- [Desktop 用户使用说明](docs/desktop-user-guide.md)
- [Desktop AI 可操作 CLI](docs/desktop-ai-cli.md)
- [SDK README](packages/sdk/README.md)

## 关键结论

Bridge Desktop 需要本地安装。

如果 SaaS 页面和 Codex 执行机器不在同一台电脑上，就必须有 Bridge Cloud 中转。用户不需要自己部署服务器，Bridge Cloud 由我们的 SaaS 平台提供。

纯本地安装也可以做 local-only 模式，但只能服务同机浏览器或本地 API，不能实现“手机/另一台电脑上的 SaaS 调用家里 Mac 上的 Codex”。

## 能力边界

Bridge Cloud 负责认证、授权关系、产品 capability 和队列边界。Bridge
Desktop 是本机权限最终执行者：SaaS 可以请求 `kind`、`policy`、
`workspace_ref` 和 payload，但本机只会在用户授权可见范围和本机白名单内执行。

授权表示某个 product 可以在可见 scope 内使用这台设备；越权 cwd、sandbox、
approval policy 或 developer instructions 会被 Desktop 拒绝。

## Spec

本仓库的文档事实源已经切到新版 spec 模式。先读：

- [spec 使用说明](spec/README.md)
- [BDD 行为契约](spec/bdd/_index.json)
- [版本简档](spec/js/版本简档.js)
- [缺陷池](spec/js/缺陷池.js)
- [技术文档](spec/js/技术文档.js)
- [质量标准](spec/js/质量标准.js)

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
浏览器 / 手机打开 Pandart 本地地址或生产 Web 地址
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
npm run pandart:local
npm run check
npm run verify:sdk-examples
npm run verify:productized-onboarding
npm run verify:desktop-ai-cli
npm run verify:spec
npm run verify:local
npm run verify:desktop-lite
npm run verify:pandart-real-codex
```

Pandart 本地聊天示例：

```bash
npm run pandart:local
```

启动后会输出：

```text
local: http://127.0.0.1:<port>
phone: http://<LAN-IP>:<port>
domain-ready: http://pandart.cc:<port> (requires DNS/hosts/tunnel)
```

这个入口是手机可打开的 ChatGPT 式对话界面：登录/创建 Pandart 账号、连接本机、发送消息、查看本机 Codex 回复。`pandart.cc` 是本版产品域名语义；真实公网访问仍需要 DNS、hosts 或 tunnel 指向这台机器。

真实 Codex 模型端到端复验：

```bash
npm run pandart:local
npm run verify:pandart-real-codex
```

该验证使用默认 `chaos@pandart.cc` 本地账号、真实本机 Codex app-server、禁用 fake Codex，并用 stripped PATH 复现 GUI 启动环境。

调用前诊断：

```bash
curl https://bridge.otherline.cc/v1/diagnostics
node apps/connector-cli/src/cli.mjs doctor --api http://127.0.0.1:8787 --state ~/.panda-bridge/connector.json --fake-codex
```

SDK 调用方可在创建 job 前执行：

```js
const preflight = await bridge.preflight();
if (!preflight.ready) {
  console.log(preflight.issues, preflight.actions);
}

const diagnostics = await bridge.diagnostics();
```

完整 SDK 调用示例：

```bash
npm run verify:sdk-examples
```

这个示例模块位于 `examples/sdk-call-examples/`，覆盖当前 SDK helper
调用面，并在本地 memory fixture 中验证账号/session、share/join、设备、
产品授权、job/events/stream/cancel、queue summary 和证据 redaction。

产品化接入端到端复验：

```bash
npm run verify:productized-onboarding
npm run verify:desktop-ai-cli
```

该验证用本地 memory Bridge、SDK 调用方和 Desktop AI CLI 覆盖用户下载后
授权、本地授权记录、多产品独立授权、单产品撤销、job 调用和 token redaction。
安装后的 Desktop 还支持 `PANDA_BRIDGE_VERIFY=1` 控制面，AI 可以通过一次性
token 启动/激活 app、打开 deep link、截图、触发 allow/revoke/refresh
等点击等价动作；`verify:desktop-ai-cli` 会从代码里执行这些动作，并断言
截图接口返回 Desktop 内置 `builtin_app_png`。详见 [Desktop AI 可操作 CLI](docs/desktop-ai-cli.md)。

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
npm run build:web
PANDA_BRIDGE_APP_URL=http://127.0.0.1:8788 npm run verify:browser
PANDA_BRIDGE_APP_URL=http://127.0.0.1:8788 npm run verify:mobile-browser
npm run verify:sdk-examples
npm run verify:local
npm run verify:desktop-lite
PANDA_BRIDGE_API_BASE=https://api.bridge.otherline.cc npm run verify:cloud
npm run verify:browser
npm run verify:mobile-browser
```

本版 spec/代码对齐的证据输出：

```text
spec/verification/evidence/v7-pandart-mobile-local-chat/server-address.json
spec/verification/v7-pandart-mobile-local-chat.html
```
