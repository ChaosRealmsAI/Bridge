# @bridge/sdk

Bridge SDK 给产品调用方一套稳定 API：账号级授权、自动桌面连接、opaque relay envelope、以及后端委托调用。

本机 Product Adapter 侧使用 `@bridge/adapter-sdk`。它封装 Adapter 侧通用的 AES-GCM envelope、Bridge AAD、authorization context 绑定、relay_key_id 校验和重复投递 response cache；并发处理同一个 replay key 时使用 `createBridgeAdapterResponseCache().getOrSetAsync(...)`，避免 in-flight duplicate delivery 重复执行本机命令。产品自己的 command handler、权限映射和本机执行仍放在产品 Adapter 包里，不进入 Bridge core 或 SDK。

模型：每个 `(产品, 账号)` 只有两个正交开关 —— **授权**（用户控制 `active`/`paused`/删除）和 **连接**（系统全自动，调用方只读 `connected`）。

本 README 覆盖 browser/server client 选择、relay envelope 字段契约、`waitForResponse`、ACK 规则、backpressure、幂等重试、Product Adapter 责任、E2EE 边界、错误表和上线 checklist。

---

## 5 分钟接入

### 前端

```js
import { createBridgeClient } from "@bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.chaos-realms.cc",
  productId: "bridge-demo",
});

// 1. 读账号级状态并渲染
const state = await bridge.state();
state.accounts.forEach((item) => render({
  email: item.account?.email,
  authorized: item.authorization?.status === "active",
  connected: item.connected, // 全自动连接，只读
}));

// 2. 就绪后发起一次通用加密 relay call（current_account 已帮你选好账号）
const current = state.current_account;
if (current?.authorization?.status === "active" && current.connected) {
  const deviceId = current.current_device.id;
  const result = await bridge.relay.createCall({
    deviceId,
    channelId: "chan_1",
    seq: 1,
    requestKey: crypto.randomUUID(),
    payload: { type: "relay.ping" },
    session: {
      encrypt: encryptForProductAdapter,
      decrypt: decryptFromProductAdapter,
    },
    timeoutMs: 120000,
  });
  render(result.payload);
  await result.ack(); // 只在调用方成功解密/处理后 ACK
}
```

### 后端（委托）

```js
import { createBridgeServerClient } from "@bridge/sdk/server";

const bridge = createBridgeServerClient({
  apiBase: "https://api.bridge.chaos-realms.cc",
  productId: "example-product",
  secret: process.env.BRIDGE_DELEGATION_SECRET,
});

const state = await bridge.state({ userId: account.id });
await bridge.authorization.pause({ userId: account.id, accountId });
await bridge.authorization.resume({ userId: account.id, accountId });
await bridge.authorization.remove({ userId: account.id, accountId });
```

server client 内部对每个委托请求做 8 字段 HMAC 签名；`timestamp`、`nonce`、`bodySha256` 全自动，你只给业务参数。完整可运行的最小示例见 [`examples/minimal-caller/`](../../examples/minimal-caller/)。

---

## API 速查

### `bridge.state()` 返回结构

```js
{
  install: { download_url, version, sha256, platform, open_url },
  accounts: [{
    account: { id, email, display_name },
    authorization: { status: "active" }, // "active" | "paused" | "revoked"
    connected: true,                     // boolean，全自动连接结果
    current_device: { id, name, online, last_seen_at, current },
  }],
  ready: true,            // 至少一个账号 active + connected
  current_account,        // 优先 active+connected → active → paused → 第一个
}
```

### authorization 命名空间

授权是账号级的，只有三个用户动作 + 一个查询 + 创建意图：

```js
await bridge.authorization.list({ accountId });    // 查询
await bridge.authorization.pause({ accountId });   // 暂停
await bridge.authorization.resume({ accountId });  // 恢复（= authorize 为 active）
await bridge.authorization.remove({ accountId });  // 删除
await bridge.authorization.createIntent({ deviceName }); // 发起新授权意图
```

后端 server client 用法相同，额外带 `userId`。

> 连接是全自动的：SDK **不**提供手动 connect / reconnect 方法。`ensureReady()` 只检查「授权 active + 设备在线」，绝不创建新意图。

### 实时与就绪

```js
for await (const next of bridge.watchState({ intervalMs: 3000 })) { /* ... */ }

const ready = await bridge.ensureReady({ wait: true, timeoutMs: 120000 });
// ready.ready: boolean
// ready.action?.kind: "authorize" | "resume_authorization" | "wait_for_device"
```

### relay

高层调用用 `bridge.relay.createCall({ payload, session })`：SDK 负责稳定 AAD、创建 product-to-device envelope、等待 device-to-product envelope，并把 ACK 留给调用方显式执行。`session.encrypt` / `session.decrypt` 由产品提供，里面放 AES-GCM、relay key、压缩和 payload 编解码。

低层调用仍可直接使用 `relay.create/list/ack/waitForResponse`，用于自管 envelope、流式 channel 或迁移期兼容。
`relay.list` 和 server `listRelayEnvelopes` 支持 `afterSeq`/`after_seq`、`limit`、`waitMs`/`wait_ms`、`includeAcked`/`include_acked`；`cursor.next_after_seq` 是单一 `channelId` 内的下一轮游标，`afterSeq > 0` 必须带 `channelId`。默认不返回已 ACK envelope。

### server client

```js
const bridge = createBridgeServerClient({ apiBase, productId, secret });

await bridge.state({ userId });
await bridge.createConnectIntent({ userId, deviceName, installId, account });
await bridge.intentStatus(token, { userId });
await bridge.authorization.pause/resume/remove({ userId, accountId });
await bridge.bootstrapRelayKey({ userId, deviceId, relayKeyBootstrap });
await bridge.createRelayEnvelope({ userId, deviceId, channelId, seq, ciphertext, aad, nonce, algorithm, senderKeyId, recipientKeyId, requestKey });
const { envelope, ack } = await bridge.waitForResponse({ userId, deviceId, channelId, afterSeq });
await decryptInProduct(envelope);
await ack();
```

`createConnectIntent` accepts both camelCase and snake_case fields such as `deviceName` / `device_name` and `installId` / `install_id`. `bootstrapRelayKey` posts the product-scoped relay key bootstrap payload to Bridge; the SDK owns the delegated HMAC headers, while the product owns key material wrapping and later payload encryption.

签名 payload（server client 内部自动生成）：

```text
METHOD
path-with-query      ← 必须含 query，否则 product_delegation_signature_invalid
productId
userId
deviceId
timestamp
nonce
bodySha256
```

---

## 错误处理

失败请求抛出 `BridgeError`，带 `{ code, status, payload }`：

```js
try {
  await bridge.relay.create({ deviceId, channelId, seq, ciphertext, aad, nonce, algorithm, senderKeyId, recipientKeyId });
} catch (error) {
  // error.status  → HTTP 状态码
  // error.code    → 稳定错误码
  // error.payload → 云端返回的原始 JSON
}
```

稳定错误码常量从 `BridgeErrorCodes` 导出：

```js
import { BridgeErrorCodes } from "@bridge/sdk";
if (error.code === BridgeErrorCodes.product_not_authorized) { /* 走授权流程 */ }
```

常见错误码：

| Code | 典型处理 |
| --- | --- |
| `authorization_paused` | 引导用户恢复授权 |
| `product_not_authorized` | 创建 / 恢复账号授权 |
| `desktop_claim_required` | 移除浏览器侧 claim 代码 |
| `device_not_found` | 刷新设备或重新走授权 |
| `install_id_required` | 桌面端修复重试 |
| `invalid_origin` | 用注册的产品 origin |
| `product_delegation_signature_invalid` | 核对 secret、productId 和 **path 含 query** |
| `product_delegation_body_hash_invalid` | 签名后 body 被改动 |
| `product_delegation_timestamp_invalid` | 同步后端时钟 |
| `product_delegation_replay` | 用新 nonce 重试 |
| `local_policy_denied` | 桌面端本地拒绝执行 |
| `legacy_runtime_api_removed` | 旧 job/Codex 接口已迁出，改用 relay envelope |
| `plaintext_fields_forbidden` | envelope 里包含明文字段，先在产品端加密 |
| `relay_device_queue_full` / `relay_account_queue_full` / `relay_product_queue_full` / `relay_channel_queue_full` | relay 未 ACK 信封达到上限，读取 `error.payload.queue.retry_after_ms` 后重试 |
| `relay_response_timeout` | 等待本机 Adapter 回包超时，调用方自行取消或重试 |
| `request_body_too_large` / `invalid_json` / `invalid_content_type` | 修正请求序列化 |

完整错误码以 `BridgeErrorCodes` 导出和 Cloud Worker 返回的稳定 `error.code` 为准。

---

## 验证

仓库根目录：

```bash
node --test packages/sdk/test/
npm run check:relay-boundary
npm run verify:relay-backpressure
npm run check:e2ee
npm run verify:sdk-examples
```
