# minimal-caller

一个最小的 Panda Bridge 调用方示例，本地即可跑通完整链路。展示当前产品服务端 SDK 的端到端流程：

1. **服务端**用 `createBridgeServerClient` 创建授权意图（connect intent，内部自动做 8 字段 HMAC 签名）
2. **桌面端**认领并确认该意图（模拟用户在 Mac 上点「允许」—— 浏览器永远不能 claim）
3. **服务端**读取账号级 `state()`，看到授权 `active` + 自动连接 `connected: true`
4. **服务端**调用 `bootstrapRelayKey()` 写入产品自管的 relay key wrapping metadata
5. **服务端**用 `createRelayEnvelope()` 发送一条不含明文业务语义的 opaque envelope
6. **桌面端**通过 connector relay API 读取、ACK 并回传 opaque response envelope
7. **服务端**用 `waitForResponse()` 收到 response 并 ACK

## 跑起来

```bash
node examples/minimal-caller/run-local.mjs
# 或
npm run verify:minimal-caller
```

不需要启动任何外部服务：示例在进程内直接调用 Cloud Worker 的 fetch handler（内存存储），SDK 只看到一个普通的 `fetch`。

预期输出：

```text
1. state(): no account yet, ready = false
2. createConnectIntent(): token = pbi_…
   front-end opens intent.deep_link to launch Panda Bridge Desktop
3. desktop claimed + confirmed the intent -> account active + device online
4. state(): account = Minimal Caller User | authorization = active | connected = true
5. bootstrapRelayKey(): key = rkx_minimal_caller
6. createRelayEnvelope(): envelope = …
7. waitForResponse(): response = … acked = true

DONE — server-created intent -> desktop approval -> relay envelope round trip.
```

## 调用方需要写什么

只有 `run-local.mjs` 顶部那段是产品后端的真实职责：

```js
const bridge = createBridgeServerClient({ apiBase, productId, secret });
await bridge.state({ userId });                       // 读账号状态
const intent = await bridge.createConnectIntent({ userId, account, deviceName, installId }); // 发起授权
await bridge.bootstrapRelayKey({ userId, deviceId, relayKeyBootstrap }); // 写入产品自管 key wrapping metadata
await bridge.createRelayEnvelope({ userId, deviceId, channelId, seq, ciphertext, aad, nonce, requestKey }); // 发 opaque request
const { envelope, ack } = await bridge.waitForResponse({ userId, deviceId, channelId, afterSeq: seq });
await ack();
```

文件里 `desktopClaim` / `desktopConfirm` / `connectorReadAndReply` / `connector` 这些 helper **不是**调用方的活，它们模拟原生桌面端与本机连接器（用的是公开的 connector API）。生产环境里这部分由真实的 Panda Bridge Desktop 完成。

Bridge 只负责授权、连接状态、HMAC delegated call 和 opaque relay 传输；业务协议、payload 加密和 key wrapping 都在产品侧。授权是用户的唯一决策（`active` / `paused` / 删除），连接全自动，调用方只读 `connected`。完整说明见 [`spec/L4/reference-materials/docs/product-integration.md`](../../spec/L4/reference-materials/docs/product-integration.md)。
