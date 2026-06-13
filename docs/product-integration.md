# Panda Bridge 产品接入指南

Panda Bridge 是通用的 Cloud-to-Local Secure Relay / Jump Host。它把产品侧的加密 relay envelope 送到用户本机，再把本机 Product Adapter 返回的加密 envelope 送回产品侧。

Bridge 不执行 Claude、Codex、Syllo、shell、fs、data 或任何垂直业务逻辑；这些能力属于产品自己的 Product Adapter。Bridge Cloud 只能看见账号、设备、产品、channel、seq、request_key、ciphertext、aad、nonce、key id 和投递状态。

默认先接公司测试服务器：

```text
API:    https://api.bridge.test.example
Web:    https://bridge.test.example
Assets: https://assets-bridge.test.example
```

生产域 `api.bridge.otherline.cc`、`bridge.otherline.cc`、`assets.bridge.otherline.cc` 只在明确生产发布时使用。

如果产品方或用户要自己维护 Bridge Cloud，按 [`docs/self-hosting.md`](./self-hosting.md) 部署 Worker 并配置 `BRIDGE_PRODUCT_REGISTRY_JSON`。桌面端会通过 `/v1/diagnostics` 读取自托管服务器声明的产品列表；Product Adapter 仍按 `PANDA_BRIDGE_ADAPTER_<PRODUCT_ID>_URL` 本机路由。

## 0. SDK

`@panda-bridge/sdk` 当前未发布到 npm。推荐在同一 monorepo 或本地 checkout 里用 `file:`：

```json
{
  "dependencies": {
    "@panda-bridge/sdk": "file:../panda-bridge/packages/sdk"
  }
}
```

导入：

```js
import { createBridgeClient } from "@panda-bridge/sdk";
import { createBridgeServerClient } from "@panda-bridge/sdk/server";
```

浏览器 client 适合用户状态、授权管理和用户会话下的 relay 调用；server client 适合产品后端用委托 HMAC 调 Bridge。

SDK 级最终调用细节见 [`docs/sdk-calling-guide.md`](./sdk-calling-guide.md)：该文档是调用方写代码时的主参考，覆盖字段、ACK、backpressure、幂等、E2EE、错误处理和 checklist。

## 1. 心智模型

每个 `(产品, 账号)` 只有两个外部状态：

| 维度 | 谁控制 | 取值 | 含义 |
| --- | --- | --- | --- |
| 授权 authorization | 用户 | `active` / `paused` / 删除 | 用户决定该产品能不能用这台 Mac。 |
| 连接 connection | 系统全自动 | `connected` / `reconnecting` | Desktop 在线即 connected；断线后自动重连。 |

调用方不要暴露 scope、capabilities、workspace、sandbox、approval、shell、Codex 等实现词。对产品 UI 来说，只需要知道账号是否授权、设备是否连接。

## 2. 前端状态与授权

```js
const bridge = createBridgeClient({
  apiBase: "https://api.bridge.test.example",
  productId: "otherline",
});

const state = await bridge.state();

for (const item of state.accounts) {
  render({
    email: item.account?.email,
    authorized: item.authorization?.status === "active",
    paused: item.authorization?.status === "paused",
    connected: item.connected,
  });
}

await bridge.authorization.pause({ accountId });
await bridge.authorization.resume({ accountId });
await bridge.authorization.remove({ accountId });
```

`state.ready === true` 表示至少有一个账号 `active + connected`。需要刷新时用 `watchState()`：

```js
for await (const next of bridge.watchState({ intervalMs: 3000 })) {
  renderAccounts(next.accounts);
}
```

`ensureReady()` 只等待现有授权和设备连接，不会创建新授权：

```js
const ready = await bridge.ensureReady({ wait: true, timeoutMs: 120000 });
if (!ready.ready) {
  // ready.action.kind: "authorize" | "resume_authorization" | "wait_for_device"
}
```

## 3. 后端委托调用

产品后端使用 `createBridgeServerClient`。secret 只放后端或 Worker secret。

```js
const bridge = createBridgeServerClient({
  apiBase: "https://api.bridge.test.example",
  productId: "otherline",
  secret: process.env.PANDA_BRIDGE_DELEGATION_SECRET,
});

const state = await bridge.state({ userId: user.id });

await bridge.authorization.pause({ userId: user.id });
await bridge.authorization.resume({ userId: user.id });
await bridge.authorization.remove({ userId: user.id });
```

委托签名 payload 是 8 行：

```text
METHOD
path含query
productId
userId
deviceId
timestamp
nonce
bodySha256
```

算法是 `HMAC-SHA256(delegation_secret, payload)`，输出 hex。手写签名时第 2 行必须包含 query；正常代码直接用 SDK。

## 4. 授权请求流程

产品后端创建 connect intent：

```js
const intent = await bridge.createConnectIntent({
  userId: user.id,
  account: { display_name: user.name },
  deviceName: "User Mac",
});
```

前端打开 `intent.deep_link`，Desktop 弹出确认。用户允许后，Desktop claim 该 intent，授权变为 `active`，连接由 Desktop 自动维持。

浏览器永远不 claim connect intent；claim 是 Desktop 的事情。

## 5. Relay Envelope

产品调用本机能力时，产品侧先加密业务请求，再把密文投给 Bridge：

```js
const created = await bridge.createRelayEnvelope({
  userId: user.id,
  deviceId,
  channelId: "my-product-channel",
  seq: 1,
  requestKey: "request-1",
  ciphertext,
  aad,
  nonce,
  algorithm: "AES-256-GCM",
  senderKeyId: "product-key-1",
  recipientKeyId: "adapter-key-1",
  meta: { adapter_id: "my-product-adapter" },
});
```

Adapter 处理完后，产品侧读取本 channel 的 `device_to_product` envelope，并在产品侧解密。推荐用 SDK 的窄等待接口：

```js
const { envelope, ack } = await bridge.waitForResponse({
  userId: user.id,
  deviceId,
  channelId: "my-product-channel",
  afterSeq: 1,
  timeoutMs: 120000,
});

const plaintext = await decryptInProduct(envelope);
await ack(); // 只有成功解密并处理后才 ACK
```

也可以手动 list + ack：

```js
const inbox = await bridge.listRelayEnvelopes({
  userId: user.id,
  deviceId,
  channelId: "my-product-channel",
  afterSeq: 1,
});

for (const item of inbox.items) {
  const plaintext = await decryptInProduct(item);
  await bridge.ackRelayEnvelope(item.id, { userId: user.id, deviceId });
}
```

Bridge 只校验 envelope 形状和投递权限，不理解 ciphertext，也不保存 prompt、reply、stdout、stderr、路径、文件内容或产品业务对象。

## 6. Product Adapter

Product Adapter 是产品自己放在用户本机的本地服务、CLI wrapper 或桌面插件。它负责：

- 只接收 Desktop 转发来的 opaque relay envelope。
- 用产品自己的密钥解密。
- 执行产品自己的本机能力。
- 把结果重新加密成 `device_to_product` response envelope。

Bridge Desktop core 只按 `PANDA_BRIDGE_ADAPTER_<PRODUCT_ID>_URL` 把 envelope POST 给 Adapter，Adapter 返回 `response_envelope` 时 Desktop 原样 POST 回 Bridge Cloud。

Adapter 必须自己处理重复投递幂等性：如果它已经为某个 inbound envelope id 或 request key 生成了 `response_envelope`，后续同一 envelope 的重试要返回同一份 encrypted response envelope，不能重新执行本机动作，也不能用同一 response request_key 生成不同密文。

示例：

```bash
PANDA_BRIDGE_ADAPTER_OTHERLINE_URL=http://127.0.0.1:4567/v1/relay-envelope
```

## 7. 端到端加密责任

端到端加密的端点是 Product App / Product Backend 和 Product Adapter，不是 Bridge Cloud。

最低要求：

- 业务明文只在产品端和 Adapter 内出现。
- Bridge envelope 不允许出现 `prompt`、`reply`、`stdout`、`stderr`、`input`、`result`、`pwd`、`ls`、本机路径或文件内容。
- session key、key agreement、rotation、device binding 和 replay 防护由产品协议决定。
- Bridge 只做 envelope idempotency、TTL、方向、设备/产品授权和 ack 状态。

## 8. 可运行样板

仓库内的最小样板是 `examples/relay-local-control`：

```bash
npm run verify:relay-local-control
npm run verify:relay-local-control:blackbox
```

它会启动 local-memory Worker、Desktop headless-poll 和本机 Product Adapter，经 relay envelope 执行：

- `pwd`
- `ls .`

该样板只证明 Bridge 能把密文控制请求送到本机 Adapter，并把加密结果带回产品侧；它不是通用 shell runner，不能移进 Bridge core。
样板还会故障注入一次 connector ack 失败，验证 Adapter 重试幂等和服务器可见字段无 `pwd`、`ls`、`stdout` 或本机路径。
`:blackbox` 版本会打开可见产品页，点击连接、`pwd`、`ls` 和旧 API 检查，并保存截图、trace、manifest 与黑盒报告。

## 9. 错误处理

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `product_not_authorized` | 账号未授权该产品 | 创建 connect intent |
| `authorization_paused` | 用户暂停授权 | 引导用户恢复 |
| `device_offline` | Desktop 不在线 | 展示 reconnecting，等待 |
| `invalid_origin` | origin 未注册 | 配置产品 origin |
| `plaintext_fields_forbidden` | envelope 带了明文字段 | 产品侧先加密，只传密文 envelope |
| `invalid_relay_envelope` | envelope 字段不合法 | 按 `relay-envelope-v1` 补字段 |
| `legacy_runtime_api_removed` | 旧 job/runtime API 已迁出 | 改用 `/relay/envelopes` |
| `relay_device_queue_full` | 设备未 ACK envelope 达到上限 | 读取 `queue.retry_after_ms` 后重试或先消费响应 |
| `relay_account_queue_full` | 账号未 ACK envelope 达到上限 | 降低并发，按 channel 消费响应 |
| `relay_product_queue_full` | 产品未 ACK envelope 达到上限 | 限制该产品并发请求 |
| `relay_channel_queue_full` | 单 channel 未 ACK envelope 达到上限 | 按 seq 顺序消费并 ACK |
| `relay_response_timeout` | 等待 Adapter 回包超时 | 由产品协议决定取消、重试或展示失败 |

## 10. 接入顺序

1. 在测试服务器注册 productId、origin 和 delegation secret。
2. 产品前端接 `state()`、授权按钮和 ready 状态。
3. 产品后端接 `createConnectIntent()` 和 relay envelope API。
4. 产品实现本机 Product Adapter 与端到端加密。
5. 用 `npm run verify:relay-local-control` 对照最小样板确认链路。
6. 再做产品自己的黑盒：真实打开产品、授权 Desktop、发送密文请求、观察 Adapter 执行和产品侧解密结果。
