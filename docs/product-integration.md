# Panda Bridge 产品接入指南

本文面向要从零接入 Panda Bridge 的 SaaS 产品（例如 Pandart、Otherline）。Panda Bridge 让你的 Web 产品通过云中转，使用用户本机 Mac 上的 Codex AI。你只需要做两件事：

- **前端**：渲染账号状态、提供「授权 / 暂停 / 删除」三个动作、在就绪后调用 Codex。
- **后端**：用 `createBridgeServerClient` 做委托签名调用（创建授权意图、查询状态、发起任务）。

你不需要接触 Desktop 的 device token，不需要管连接，也不需要复刻任何状态推导。

---

## 1. 心智模型：账号级双开关 + 自动连接

每个 `(产品, 账号)` 只有两个**正交**维度：

| 维度 | 谁控制 | 取值 | 含义 |
| --- | --- | --- | --- |
| **授权 authorization** | 用户 | `active` / `paused` / 删除 | 用户决定这个账号能不能用这台 Mac。`active`=可用；`paused`=暂停但保留记录；删除=彻底移除授权。 |
| **连接 connection** | 系统全自动 | `connected` / `reconnecting` | 桌面端在线即 `connected`；断网/重启自动退避重连，期间 `reconnecting`。**用户和调用方都从不手动管连接。** |

一句话：**授权是用户的唯一决策，连接是全自动的，你（调用方）只需要看 `connected` 这个布尔值。**

- 用户只能做三件事：暂停/恢复授权、删除授权、（空态时）打开你的产品网页去发起新授权。
- 连接没有按钮。桌面端开机自启 + 心跳 + 断线指数退避重连 + 设备身份静默复用；恢复后自动继续，绝不重新弹授权窗。
- `paused` 时谈不上连接，UI 应把连接显示为不可用。

> 对外、对用户界面**不要**暴露 scope / capabilities / workspace / sandbox / approval / 工作目录 / 「full-access」这些实现层概念。它们是云端与本机的安全兜底，不是产品能力。Bridge 记录的事实是：`Panda 账号 + 产品 + 这台 Mac + 授权状态`。

同一账号可以有多台 Mac；同一台 Mac 可以服务多个账号；每个产品的授权各自独立。

---

## 2. 前端接入（最少代码）

前端用浏览器 client。它的唯一职责是渲染 `state()` 并暴露三个授权动作。

```js
import { createBridgeClient } from "@panda-bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "otherline",
});

// 1. 读取账号级状态
const state = await bridge.state();

// 2. 渲染：每个账号一行（邮箱 + 授权开关 + 连接指示灯）
for (const item of state.accounts) {
  render({
    email: item.account?.email,
    authorized: item.authorization?.status === "active",   // 授权开关
    paused: item.authorization?.status === "paused",
    connected: item.connected,                              // 连接全自动，只读
  });
}

// 3. 三个用户动作
await bridge.authorization.pause({ accountId });   // 暂停
await bridge.authorization.resume({ accountId });  // 恢复
await bridge.authorization.remove({ accountId });  // 删除
```

`bridge.state()` 返回的账号级模型：

```js
{
  install: { download_url, version, sha256, platform, open_url },
  accounts: [{
    account: { id, email, display_name },
    authorization: { status: "active" }, // active | paused | revoked
    connected: true,                     // 全自动连接结果，只读
    current_device: { id, name, online, last_seen_at, current },
  }],
  ready: true,                           // 至少一个账号 active + connected
  current_account,                       // 优先 active+connected，否则 active，否则 paused
}
```

### 自动连接如何体现

调用方不发起、不重连、不显示「连接」按钮。连接状态完全体现在 `connected` 字段上：

- `authorization.status === "active" && connected === true` → 就绪，可以调 Codex。
- `authorization.status === "active" && connected === false` → 桌面端正在重连（reconnecting），等待即可，**不要**重新发起授权。
- `authorization.status === "paused"` → 用户暂停了，引导「恢复授权」。
- 没有任何账号 → 空态，引导用户打开产品网页发起新授权（见第 4 节）。

需要实时刷新时用 `watchState()`，它默认每 3 秒轮询、`document.hidden` 时暂停，并在可用时用设备实时通道加速：

```js
for await (const next of bridge.watchState({ intervalMs: 3000 })) {
  renderAccounts(next.accounts);
}
```

`ensureReady()` 只检查「授权 active + 设备在线」，**绝不**创建新的授权意图：

```js
const ready = await bridge.ensureReady({ wait: true, timeoutMs: 120000 });
if (!ready.ready) {
  // ready.action.kind: "authorize" | "resume_authorization" | "wait_for_device"
}
```

---

## 3. 后端接入（委托 + HMAC 8 字段签名）

产品后端用 server client。它内部完成全部委托签名（HMAC、timestamp、nonce、body hash、重放防护），你只提供业务参数。

```js
import { createBridgeServerClient } from "@panda-bridge/sdk/server";

const bridge = createBridgeServerClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "otherline",
  secret: process.env.PANDA_BRIDGE_DELEGATION_SECRET, // 只放后端 / Worker secret
});

// 查询某用户的账号级状态
const state = await bridge.state({ userId: user.id });

// 授权管理（与前端等价，但走委托签名）
await bridge.authorization.pause({ userId: user.id, accountId });
await bridge.authorization.resume({ userId: user.id, accountId });
await bridge.authorization.remove({ userId: user.id, accountId });
```

`userId` 是你自己产品侧的用户 ID；Bridge 内部按产品命名空间隔离，不同产品的同名 `userId` 互不相干。

### 委托 HMAC 8 字段签名规范（逐字段）

signing payload 必须按 **8 行**用 `\n` 拼接，顺序与含义如下：

```text
METHOD          ← 大写 HTTP 方法，如 POST
path含query     ← URL pathname + query，如 /v1/products/otherline/delegated/authorization?device_id=dev_1
productId       ← 注册的产品 ID
userId          ← 产品侧用户 ID
deviceId        ← 目标设备 ID；不针对设备时用约定值（state 用 "account"，建意图用 "pending"）
timestamp       ← ISO 字符串，如 2026-06-12T12:00:00.000Z
nonce           ← 每次请求唯一
bodySha256      ← 请求体原文的 SHA-256 hex；GET / 空 body 用空字符串的 hash
```

算法：`HMAC-SHA256(delegation_secret, signingPayload)`，输出 hex。

对应请求头：

```text
x-panda-bridge-product-id:        <productId>
x-panda-bridge-user-id:           <userId>
x-panda-bridge-device-id:         <deviceId>
x-panda-bridge-request-timestamp: <timestamp>
x-panda-bridge-request-nonce:     <nonce>
x-panda-bridge-body-sha256:       <bodySha256>
x-panda-bridge-signature:         <hmacSha256Hex>
content-type:                     application/json
```

> ⚠️ **最容易踩的坑：第 2 行的 path 必须包含 query。** 例如 `/v1/products/otherline/delegated/authorization?device_id=dev_1`，漏掉 `?device_id=dev_1` 就会得到 `product_delegation_signature_invalid`。`createBridgeServerClient` 已经帮你正确处理；**只有手写签名时**才需要自己注意这一点。

**nonce 规则**：每次请求必须唯一（一次性）。同产品重放同一 nonce 返回 `product_delegation_replay`。server client 默认用 `crypto.randomUUID()`。

**timestamp 规则**：ISO 字符串，必须落在服务端允许的时钟偏移内，超出返回 `product_delegation_timestamp_invalid`。请保证后端时钟同步。

生产代码一律用 `createBridgeServerClient`；手写签名只用于诊断或非 JS 后端移植。

---

## 4. 授权请求流程（调用方发起 → 桌面端确认 → 账号出现）

新账号从无到有的完整流程：

1. **后端创建授权意图**（connect intent）：

   ```js
   const intent = await bridge.createConnectIntent({
     userId: user.id,
     account: { display_name: user.name }, // 可选，用于桌面端显示
     deviceName: "User Mac",
   });
   // intent.token / intent.deep_link
   ```

2. **前端把用户引导到桌面端**：用返回的 `deep_link`（`panda-bridge://connect?intent=...`）唤起已安装的 Panda Bridge；未安装则先用 `state.install.download_url` 引导下载。

3. **桌面端弹窗确认**：用户在 Mac 上看到「X 想连接这台 Mac」+ 域名 + 授权给哪个账号 + 拒绝/允许。确认后桌面端原生 claim 该意图（**浏览器永远不调用 claim，那是桌面端的事**）。

4. **账号出现**：claim 成功后，该 `(产品, 账号)` 的授权变为 `active`，连接随心跳自动建立。前端的 `state().accounts` 里就会出现这个账号且 `connected: true`。

5. **轮询意图状态（可选）**：等待期间后端可查 `bridge.intentStatus(intent.token, { userId })`。

就绪后即可发起任务：

```js
const created = await bridge.createJob({
  userId: user.id,
  deviceId,                 // 取自 state 的 current_account.current_device.id
  kind: "codex.chat",
  input: { prompt: "只回复 OK" },
  requestKey: crypto.randomUUID(), // 幂等键
});

const events = await bridge.jobEvents(created.job.id, { userId: user.id, deviceId });
```

---

## 5. 错误码全表

所有 SDK 请求失败时抛出 `BridgeError`，带 `error.status`（HTTP）、`error.code`、`error.payload`。

### 授权 / 连接类

| Code | HTTP | 含义 | 怎么处理 |
| --- | --- | --- | --- |
| `authorization_paused` | 403 | 该账号授权被用户暂停 | 引导用户「恢复授权」，不要重发意图 |
| `product_not_authorized` | 403 | 该产品对此账号无 active 授权 | 走第 4 节授权请求流程 |
| `already_authorized` | 200 | 已授权的幂等快路径 | 直接进入就绪态，不显示授权按钮 |
| `invalid_connect_intent` | 400 | 意图不存在、已消费或过期 | 重新创建 connect intent |
| `desktop_claim_required` | 403 | 浏览器尝试 claim 原生意图 | 移除浏览器侧 claim 代码；claim 只能桌面端做 |
| `device_not_found` | 404 | 设备不存在或已撤销 | 刷新设备 / 重新走授权流程 |

### 委托签名类（后端最常见）

| Code | HTTP | 含义 | 怎么处理 |
| --- | --- | --- | --- |
| `product_delegation_signature_invalid` | 401 | HMAC 输入或 secret 不匹配 | **逐字段核对 8 行，尤其 path 含 query**；核对 secret |
| `product_delegation_replay` | 401 | nonce 已使用 | 用新的 nonce 重试 |
| `product_delegation_timestamp_invalid` | 401 | timestamp 超出允许偏移 | 同步后端时钟后重签 |
| `product_delegation_body_hash_invalid` | 401 | body hash 与请求体不一致 | 按实际发送的 body 重算 hash（注意序列化要一致） |
| `product_delegation_unauthorized` | 401 | 委托签名头缺失或身份无效 | 检查 server client 配置（apiBase/productId/secret） |
| `product_delegation_not_configured` | 503 | 产品 secret 未在云端配置 | 联系云端配置该产品的 delegation secret |
| `install_id_required` | 400 | Desktop claim 缺少 install_id | 桌面端修复重试；产品侧继续等待/重试 |
| `invalid_origin` | 403 | 浏览器请求来源不在产品 allowlist | 用注册的产品 origin 发请求；检查 origin 映射 |
| `product_origin_mismatch` | 403 | Origin 与 product_id 不匹配 | 用该产品自己注册的 origin |

### 请求 / 运行类

| Code | HTTP | 含义 | 怎么处理 |
| --- | --- | --- | --- |
| `local_policy_denied` | job result | 桌面端本地拒绝了越权任务 | 缩小本地请求或重新授权 |
| `idempotency_key_conflict` | 409 | 同 requestKey 但 body 不同 | 换新的 requestKey，或确保 body 一致 |
| `request_body_too_large` | 413 | JSON body 超限 | 缩小请求 |
| `invalid_json` | 400 | body 不是合法 JSON | 修正序列化 |
| `invalid_content_type` | 415 | 写请求不是 JSON | 设置 `content-type: application/json` |
| `unauthorized` | 401 | 无有效会话 | 让用户登录 |

错误处理范式：

```js
try {
  await bridge.createJob({ userId, deviceId, kind: "codex.chat", input });
} catch (error) {
  if (error.code === "product_not_authorized") {
    // 走授权流程
  } else if (error.code === "authorization_paused") {
    // 引导恢复
  } else {
    console.error(error.status, error.code, error.payload);
  }
}
```

---

## 6. 端到端示例（curl 级）

下面是手写签名的端到端示例，演示一个委托任务请求。**生产请用 `createBridgeServerClient`**，这里仅用于理解协议。

Node 侧生成签名：

```js
import { createHash, createHmac, randomUUID } from "node:crypto";

const method = "POST";
const path = "/v1/products/otherline/delegated/jobs"; // 无 query 时就是纯 path
const bodyText = JSON.stringify({
  device_id: "dev_123",
  kind: "codex.chat",
  input: { prompt: "Reply OK" },
  request_key: "demo-001",
});
const productId = "otherline";
const userId = "user_123";
const deviceId = "dev_123";
const timestamp = new Date().toISOString();
const nonce = randomUUID();
const bodySha256 = createHash("sha256").update(bodyText).digest("hex");

const signingPayload = [
  method.toUpperCase(),
  path,            // ← 有 query 时这里必须带上 query
  productId,
  userId,
  deviceId,
  timestamp,
  nonce,
  bodySha256,
].join("\n");

const signature = createHmac("sha256", process.env.PANDA_BRIDGE_DELEGATION_SECRET)
  .update(signingPayload)
  .digest("hex");
```

curl 请求：

```bash
curl "https://api.bridge.otherline.cc/v1/products/otherline/delegated/jobs" \
  -X POST \
  -H "content-type: application/json" \
  -H "x-panda-bridge-product-id: otherline" \
  -H "x-panda-bridge-user-id: user_123" \
  -H "x-panda-bridge-device-id: dev_123" \
  -H "x-panda-bridge-request-timestamp: 2026-06-12T12:00:00.000Z" \
  -H "x-panda-bridge-request-nonce: 0198f0f4-0c8e-7b85-9f12-demo" \
  -H "x-panda-bridge-body-sha256: <sha256-of-body>" \
  -H "x-panda-bridge-signature: <hmac-sha256-hex>" \
  --data '{"device_id":"dev_123","kind":"codex.chat","input":{"prompt":"Reply OK"},"request_key":"demo-001"}'
```

可运行的最小接入示例（内存 Worker，本地即可跑）见 [`examples/minimal-caller/`](../examples/minimal-caller/)。

---

## 7. 注册产品（前置）

接入前先在 Bridge Cloud 注册：

- `product_id`：稳定 ID，例如 `otherline`、`panda-chat`。
- official origins：产品真实浏览器来源；浏览器请求必须来自该产品自己的 origin。
- delegation secret：服务端 HMAC secret，只放后端 / Worker secret。

参考实现：Worker 的委托签名校验在 `apps/cloud-worker/test/worker.test.mjs`（`delegatedApiRawText`），8 字段顺序与本文逐字段一致。
