# minimal-caller

一个最小的 Panda Bridge 调用方示例，本地即可跑通完整链路。展示 v2 账号级模型的端到端流程：

1. **服务端**用 `createBridgeServerClient` 创建授权意图（connect intent，内部自动做 8 字段 HMAC 签名）
2. **桌面端**认领该意图（模拟用户在 Mac 上点「允许」—— 浏览器永远不能 claim）
3. **前端**读取账号级 `state()`，看到授权 `active` + 自动连接 `connected: true`
4. **服务端**在账号就绪后调用 `codex.chat`，桌面端连接器执行并回传结果

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
3. desktop claimed the intent → account authorized + device online
4. state(): account = Minimal Caller User | authorization = active | connected = true
5. createJob(codex.chat): job = … status = queued
   job events: queued, claimed, started, completed

DONE — server-created intent → desktop approval → codex.chat round trip.
```

## 调用方需要写什么

只有 `run-local.mjs` 顶部那段是产品后端的真实职责：

```js
const bridge = createBridgeServerClient({ apiBase, productId, secret });
await bridge.state({ userId });                       // 读账号状态
const intent = await bridge.createConnectIntent({ userId, account, deviceName }); // 发起授权
const job = await bridge.createJob({ userId, deviceId, kind: "codex.chat", input, requestKey }); // 调 Codex
await bridge.jobEvents(job.job.id, { userId, deviceId });
```

文件里 `desktopClaim` / `connectorComplete` / `connector` 这些 helper **不是**调用方的活，它们模拟原生桌面端与本机连接器（用的是公开的 connector API）。生产环境里这部分由真实的 Panda Bridge Desktop 完成。

授权是用户的唯一决策（`active` / `paused` / 删除），连接全自动，调用方只读 `connected`。完整说明见 [`docs/product-integration.md`](../../docs/product-integration.md)。
