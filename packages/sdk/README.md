# @panda-bridge/sdk

Panda Bridge SDK 给产品调用方一套稳定 API：账号级授权、自动桌面连接、opaque relay envelope、以及后端委托调用。

模型：每个 `(产品, 账号)` 只有两个正交开关 —— **授权**（用户控制 `active`/`paused`/删除）和 **连接**（系统全自动，调用方只读 `connected`）。完整接入指南见 [`docs/product-integration.md`](../../docs/product-integration.md)。

---

## 5 分钟接入

### 前端

```js
import { createBridgeClient } from "@panda-bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "panda-chat",
});

// 1. 读账号级状态并渲染
const state = await bridge.state();
state.accounts.forEach((item) => render({
  email: item.account?.email,
  authorized: item.authorization?.status === "active",
  connected: item.connected, // 全自动连接，只读
}));

// 2. 就绪后投递密文 envelope（current_account 已帮你选好账号）
const current = state.current_account;
if (current?.authorization?.status === "active" && current.connected) {
  const deviceId = current.current_device.id;
  const created = await bridge.relay.create({
    deviceId,
    channelId: "chan_1",
    seq: 1,
    ciphertext: encryptedBody,
    aad: encodedAad,
    nonce,
    algorithm: "AES-GCM-256",
    senderKeyId: "product-key-1",
    recipientKeyId: "device-key-1",
    requestKey: crypto.randomUUID(),
  });
  console.log(created.envelope.id);

  const { envelope, ack } = await bridge.relay.waitForResponse({
    deviceId,
    channelId: "chan_1",
    afterSeq: 1,
    timeoutMs: 120000,
  });
  const plaintext = await decryptInProduct(envelope);
  await ack(); // 只在调用方成功解密/处理后 ACK
}
```

### 后端（委托）

```js
import { createBridgeServerClient } from "@panda-bridge/sdk/server";

const bridge = createBridgeServerClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "otherline",
  secret: process.env.PANDA_BRIDGE_DELEGATION_SECRET,
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

### server client

```js
const bridge = createBridgeServerClient({ apiBase, productId, secret });

await bridge.state({ userId });
await bridge.createConnectIntent({ userId, deviceName, account });
await bridge.intentStatus(token, { userId });
await bridge.authorization.pause/resume/remove({ userId, accountId });
await bridge.createRelayEnvelope({ userId, deviceId, channelId, seq, ciphertext, aad, nonce, algorithm, senderKeyId, recipientKeyId, requestKey });
const { envelope, ack } = await bridge.waitForResponse({ userId, deviceId, channelId, afterSeq });
await decryptInProduct(envelope);
await ack();
```

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
import { BridgeErrorCodes } from "@panda-bridge/sdk";
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

完整错误码表见 [`docs/product-integration.md` 第 5 节](../../docs/product-integration.md)。

---

## 验证

仓库根目录：

```bash
node --test packages/sdk/test/
npm run check:relay-boundary
npm run verify:relay-backpressure
npm run check:e2ee
npm run verify:sdk-examples
node scripts/verify/spec-traceability.mjs
```
