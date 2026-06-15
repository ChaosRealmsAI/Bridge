# Panda Bridge SDK 最终调用手册

本文是产品调用方接 Panda Bridge 的 SDK 级最终手册。Bridge 的定位只有一个：**Hosted Secure Relay / Jump Host**。Bridge Cloud 和 Bridge Desktop core 只负责账号、授权、设备在线、opaque encrypted relay envelope、ACK、TTL、幂等和 backpressure；业务协议、加解密、执行逻辑、重试语义和 UI 都在调用方产品与 Product Adapter。

## 1. 选哪个 Client

| 场景 | Client | 凭据位置 | 典型用途 |
| --- | --- | --- | --- |
| 浏览器产品前端 | `createBridgeClient` | 用户 session cookie | 展示授权状态、发起授权、投递密文 envelope、等待密文响应 |
| 产品后端 / Worker | `createBridgeServerClient` | 后端 secret | 代表产品用户做委托 HMAC 请求、创建 connect intent、投递/读取 relay envelope |
| 本机 Product Adapter | 不用 SDK 调 Bridge Cloud | Desktop 转发给 Adapter | 解密 envelope、执行本机能力、返回 encrypted response_envelope |

不要在 SDK 外新增 `jobs`、`codex`、`shell`、`fs`、`data` 这类 helper。它们不是 Bridge 能力。

## 2. 安装与初始化

当前 SDK 未发布到 npm，monorepo / 本地 checkout 推荐用 `file:`：

```json
{
  "dependencies": {
    "@panda-bridge/sdk": "file:../panda-bridge/packages/sdk"
  }
}
```

浏览器端：

```js
import { createBridgeClient, BridgeErrorCodes } from "@panda-bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.test.example",
  productId: "otherline",
});
```

后端：

```js
import { createBridgeServerClient } from "@panda-bridge/sdk/server";

const bridge = createBridgeServerClient({
  apiBase: "https://api.bridge.test.example",
  productId: "otherline",
  secret: process.env.PANDA_BRIDGE_DELEGATION_SECRET,
});
```

生产域只在明确发布时切换到 `https://api.bridge.otherline.cc`。默认开发、联调、黑盒都用 test 域。

## 3. 状态模型

每个 `(product, account)` 只有两个产品可见状态：

| 状态 | 谁控制 | 产品怎么用 |
| --- | --- | --- |
| `authorization.status` | 用户控制 | `active` 表示允许；`paused` 表示用户暂停；删除表示不再授权 |
| `connected` | 系统自动 | Desktop 在线即 true；断线后 Desktop 自动重连 |

浏览器读取状态：

```js
const state = await bridge.state();

for (const item of state.accounts) {
  renderAccount({
    accountId: item.account?.id,
    email: item.account?.email,
    authorized: item.authorization?.status === "active",
    paused: item.authorization?.status === "paused",
    connected: item.connected,
    deviceId: item.current_device?.id,
  });
}
```

推荐选择 `state.current_account` 作为默认调用账号。它的优先级是：`active + connected`，其次 `active`，再其次 `paused`，最后第一个账号。

实时轮询：

```js
for await (const next of bridge.watchState({ intervalMs: 3000 })) {
  renderAccounts(next.accounts);
}
```

就绪等待：

```js
const ready = await bridge.ensureReady({ wait: true, timeoutMs: 120000 });

if (!ready.ready) {
  switch (ready.action?.kind) {
    case "authorize":
      showAuthorizeButton();
      break;
    case "resume_authorization":
      showResumeButton();
      break;
    case "wait_for_device":
      showReconnecting();
      break;
  }
}
```

`ensureReady()` 只检查授权与在线，不创建新授权，不 claim Desktop，不做业务调用。

## 4. 授权流程

浏览器可创建授权意图：

```js
const intent = await bridge.authorization.createIntent({
  deviceName: "User Mac",
});

window.location.href = intent.deep_link;
```

用户在 Desktop 侧确认后，状态变为 `active`。浏览器不要 claim connect intent；claim 是 Desktop 的动作。

账号级授权管理：

```js
await bridge.authorization.list({ accountId });
await bridge.authorization.pause({ accountId });
await bridge.authorization.resume({ accountId });
await bridge.authorization.remove({ accountId });
```

后端委托版本额外传 `userId`：

```js
await bridge.authorization.pause({ userId, accountId });
await bridge.authorization.resume({ userId, accountId });
await bridge.authorization.remove({ userId, accountId });
```

## 5. Relay Envelope 字段契约

Bridge 只接受 encrypted relay envelope。必须字段：

| 字段 | 含义 | 注意 |
| --- | --- | --- |
| `deviceId` / `device_id` | 目标设备 | 来自 `state.current_account.current_device.id` |
| `channelId` / `channel_id` | 产品自定义 channel | 一个请求/会话流一个稳定 channel |
| `seq` | channel 内单调序号 | 调用方决定，响应等待用 `afterSeq` |
| `requestKey` / `request_key` | 幂等 key | 同 key + 完全相同 envelope 返回 `reused=true` |
| `ciphertext` | 产品密文 | Bridge 不解密 |
| `aad` | 加密 AAD | 建议绑定 product/device/channel/seq/requestKey |
| `nonce` | 加密 nonce / iv | 同密钥下不可复用 |
| `algorithm` | 算法标识 | 例如 `AES-256-GCM` |
| `senderKeyId` | 发送方 key id | 产品协议自定义 |
| `recipientKeyId` | 接收方 key id | Adapter key id |
| `meta` | 路由/诊断元数据 | 只允许 allowlist 字段，不能放业务明文 |

禁止字段包括 `prompt`、`input`、`payload`、`message`、`response`、`result`、`stdout`、`stderr`、`command`、`path`、文件内容、项目路径和任何业务对象。命中会返回 `plaintext_fields_forbidden`。

## 6. 浏览器端完整调用

```js
async function callLocalAdapter(command) {
  const state = await bridge.ensureReady({ wait: true, timeoutMs: 120000 });
  if (!state.ready) throw new Error(`Bridge not ready: ${state.action?.kind || "unknown"}`);

  const account = state.current_account;
  const deviceId = account.current_device.id;
  const channelId = `otherline:${crypto.randomUUID()}`;
  const seq = 1;
  const requestKey = crypto.randomUUID();

  const encrypted = await encryptForAdapter({
    command,
    aad: { productId: "otherline", deviceId, channelId, seq, requestKey },
  });

  const created = await bridge.relay.create({
    deviceId,
    channelId,
    seq,
    requestKey,
    ciphertext: encrypted.ciphertext,
    aad: encrypted.aad,
    nonce: encrypted.nonce,
    algorithm: encrypted.algorithm,
    senderKeyId: encrypted.senderKeyId,
    recipientKeyId: encrypted.recipientKeyId,
    meta: { adapter_id: "otherline-adapter", trace_id: requestKey },
  });

  if (created.reused) {
    // 说明同 requestKey 的完全相同 envelope 已存在；继续等响应即可。
  }

  const { envelope, ack } = await bridge.relay.waitForResponse({
    deviceId,
    channelId,
    afterSeq: seq,
    timeoutMs: 120000,
    intervalMs: 900,
  });

  const plaintext = await decryptFromAdapter(envelope);
  await processResult(plaintext);
  await ack({ status: "acked" });
  return plaintext;
}
```

ACK 规则：**调用方成功解密并完成自己的处理后再 ACK**。不要在收到 envelope 时立刻 ACK；否则产品处理失败时 Bridge 会认为响应已消费。

低层 `relay.list` / `listRelayEnvelopes` 可用于自管 channel、流式消费或诊断：

```js
const inbox = await bridge.relay.list({
  deviceId,
  channelId,
  afterSeq: lastSeenSeq,
  limit: 50,
  waitMs: 30000,
  includeAcked: false,
});

for (const envelope of inbox.items) {
  await handleEnvelope(envelope);
}
lastSeenSeq = inbox.cursor.next_after_seq;
```

列表契约：

- `afterSeq` / `after_seq` 是单一 `channelId` / `channel_id` 内的排他游标；非法值按 `0` 处理，`afterSeq > 0` 但未传 `channelId` 会返回 `relay_cursor_requires_channel`。
- `limit` 默认 `100`，范围 `1..500`。
- `waitMs` / `wait_ms` 默认 `0`，最大 `30000`，用于服务端长轮询，返回前有新 envelope 会立即结束等待。
- 默认只返回 `queued` / `delivered` 且未过期的 envelope；`includeAcked: true` 只用于审计、诊断或恢复场景。
- 响应包含 `cursor.after_seq`、`cursor.next_after_seq`、`cursor.limit`、`cursor.returned`、`cursor.has_more` 和 `cursor.include_acked`；同一 channel 的下一轮用 `next_after_seq` 继续。

## 7. 后端委托完整调用

```js
async function callFromBackend({ userId, deviceId, command }) {
  const channelId = `otherline:${crypto.randomUUID()}`;
  const seq = 1;
  const requestKey = crypto.randomUUID();
  const encrypted = await encryptForAdapter({ command, aad: { userId, deviceId, channelId, seq, requestKey } });

  await bridge.createRelayEnvelope({
    userId,
    deviceId,
    channelId,
    seq,
    requestKey,
    ciphertext: encrypted.ciphertext,
    aad: encrypted.aad,
    nonce: encrypted.nonce,
    algorithm: encrypted.algorithm,
    senderKeyId: encrypted.senderKeyId,
    recipientKeyId: encrypted.recipientKeyId,
    meta: { adapter_id: "otherline-adapter", trace_id: requestKey },
  });

  const { envelope, ack } = await bridge.waitForResponse({
    userId,
    deviceId,
    channelId,
    afterSeq: seq,
    timeoutMs: 120000,
  });

  const plaintext = await decryptFromAdapter(envelope);
  await persistResult(userId, plaintext);
  await ack({ status: "acked" });
  return plaintext;
}
```

server client 自动签名所有委托请求。签名 payload 是：

```text
METHOD
path-with-query
productId
userId
deviceId
timestamp
nonce
bodySha256
```

第 2 行必须包含 query；SDK 已处理，手写签名时最容易错在这里。

## 8. Backpressure 与重试

Relay backpressure 按未 ACK 且未过期的 encrypted envelope 计数：

| Scope | 默认上限 | 错误码 |
| --- | ---: | --- |
| device | 150 | `relay_device_queue_full` |
| account | 500 | `relay_account_queue_full` |
| product | 300 | `relay_product_queue_full` |
| channel | 50 | `relay_channel_queue_full` |

错误 payload：

```json
{
  "error": "relay_channel_queue_full",
  "queue": {
    "scope": "channel",
    "active": 50,
    "max_unacked": 50,
    "retry_after_ms": 3000
  }
}
```

推荐处理：

```js
try {
  await bridge.relay.create(envelope);
} catch (error) {
  if (String(error.code || "").startsWith("relay_") && error.payload?.queue?.retry_after_ms) {
    await sleep(error.payload.queue.retry_after_ms);
    return retrySameEnvelopeWithSameRequestKey();
  }
  throw error;
}
```

重试原则：

- 网络失败且不确定是否入队：用同一个 `requestKey` 和完全相同 envelope 重试。
- 同 `requestKey` + 完全相同 envelope：Bridge 返回已有 envelope 和 `reused=true`。
- 同 `requestKey` 但 `ciphertext`、`seq`、`algorithm`、`ttl_ms`、`meta` 或 `envelope_version` 不同：Bridge 返回 `idempotency_key_conflict`。
- 想发新请求：换新的 `requestKey`。

## 9. Product Adapter 责任

Adapter 收到 Desktop 转发的 inbound envelope 后：

1. 校验 product/device/channel/seq/requestKey/AAD。
2. 解密业务请求。
3. 执行产品自己的本机能力。
4. 生成 `device_to_product` encrypted response envelope。
5. 对同一个 inbound envelope id 或 requestKey 做幂等缓存。

ack 失败时 Desktop 会 redeliver 同一个 inbound envelope。Adapter 必须返回同一份 cached response envelope，不能重复执行本机动作，也不能用同一个 response requestKey 生成不同密文。

## 10. E2EE 边界

Bridge 不是加密端点。E2EE 端点是 Product App / Product Backend 与 Product Adapter。

产品必须自己实现：

- session key 或 key agreement。
- key id、rotation、device binding。
- nonce 唯一性。
- AAD 绑定 product/device/channel/seq/requestKey。
- replay 防护。
- 业务 schema 版本。

Bridge 只保证：

- 不接受明显的业务明文字段。
- 不解密 ciphertext。
- 按授权和在线设备路由 envelope。
- 短 TTL 存储、ACK、幂等和 backpressure。

## 11. 错误处理总表

所有失败会抛 `BridgeError`：

```js
try {
  await bridge.relay.create(envelope);
} catch (error) {
  console.log(error.code, error.status, error.payload);
}
```

| 错误码 | 处理 |
| --- | --- |
| `product_not_authorized` | 创建授权意图或让用户恢复授权 |
| `authorization_paused` | 展示“恢复授权” |
| `device_not_found` | 刷新状态或重新授权 |
| `device_offline` | 展示 reconnecting，等待 Desktop 在线 |
| `invalid_origin` / `product_origin_mismatch` | 检查产品 origin 注册 |
| `plaintext_fields_forbidden` | 先加密业务 payload，只传密文字段 |
| `invalid_relay_envelope` | 补齐 envelope 必填字段 |
| `idempotency_key_conflict` | 同 requestKey 请求体变了；换新 requestKey 或重试原 envelope |
| `relay_*_queue_full` | 读 `queue.retry_after_ms` 后退避；优先消费并 ACK 旧响应 |
| `relay_response_timeout` | Adapter 未及时回包；产品决定取消、重试或提示失败 |
| `relay_envelope_expired` | 请求已过 TTL；换新 requestKey 重新发 |
| `legacy_runtime_api_removed` | 旧 `/jobs` / Codex runtime API 已迁出，改用 relay envelope |
| `product_delegation_signature_invalid` | 检查 secret、productId、userId、deviceId 和 path-with-query |
| `product_delegation_replay` | nonce 重放，换新 nonce |

## 12. 最终接入 Checklist

- 前端只展示授权与连接，不展示 Bridge 内部 scope/sandbox/agent 词。
- 调用前检查 `active + connected`。
- 所有业务请求先加密，Bridge envelope 不含明文。
- 每个请求有稳定 `channelId`、单调 `seq`、唯一 `requestKey`。
- 网络不确定时用同一 envelope + 同一 requestKey 重试。
- 成功解密并处理响应后再 ACK。
- Adapter 对重复 inbound envelope 幂等，不重复执行本机动作。
- 遇到 `relay_*_queue_full` 按 `retry_after_ms` 退避并降低并发。
- 后端 secret 只存在服务端，不进浏览器。
- 产品黑盒必须真实打开产品、授权 Desktop、发送密文请求、观察 Adapter 执行和产品侧解密结果。

## 13. 验证命令

仓库内 Bridge 自检：

```bash
npm run check
npm run verify:relay-backpressure
npm run verify:relay-local-control
npm run verify:relay-local-control:blackbox
bash spec/check-template.sh
```

这些命令证明 Bridge 作为跳板机可用，并验证 SDK 窄接口、backpressure、`pwd` / `ls` 样板和旧 runtime API 410。产品上线前仍需要产品自己的黑盒验证；本地样板不能替代生产部署证明。
