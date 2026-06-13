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

- Bridge Cloud 不执行 Claude、Codex、Syllo、shell、fs 或 data 业务。
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

## 服务器选择

默认给用户使用我们提供的 Bridge Cloud，用户不需要自建服务器。

当前收尾和接入验证优先使用公司 test 资源：

```text
API:    https://api.bridge.test.example
Web:    https://bridge.test.example
Assets: https://assets-bridge.test.example
```

生产资源只在明确发布时使用：

```text
API:    https://api.bridge.otherline.cc
Web:    https://bridge.otherline.cc
Assets: https://assets.bridge.otherline.cc
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
npm run check:e2ee
npm run verify:relay-local-control
npm run verify:relay-local-control:blackbox
bash spec/check-template.sh --no-smoke
```

常用开发入口：

```bash
npm run cloud:dev
npm run desktop:dev
npm run pandart:local
```

部署 test Worker 使用 `apps/cloud-worker/wrangler.test.toml`；生产部署需要单独确认。

## Spec

本仓库使用 v2 spec：

- `spec/bdd/*.json` 是产品行为真相。
- `spec/js/技术文档.js` 记录长期架构和接口契约。
- `spec/js/工程护栏.js` 记录可执行防回退检查。
- `spec/js/versions/v0-2/*` 是当前 relay/e2ee/adapter 版本事实。

先读：

```text
spec/bdd/_index.json
spec/js/技术文档.js
spec/js/质量标准.js
spec/js/工程护栏.js
spec/js/versions/v0-2/版本总览.js
```
