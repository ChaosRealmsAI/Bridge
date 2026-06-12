# Panda Bridge 产品接入指南

本文面向要从零接入 Panda Bridge 的 SaaS 产品（例如 Pandart、Otherline）。Panda Bridge 让你的 Web 产品通过云中转，使用用户本机 Mac 上的 Codex AI。你只需要做两件事：

- **前端**：渲染账号状态、提供「授权 / 暂停 / 删除」三个动作、在就绪后调用 Codex。
- **后端**：用 `createBridgeServerClient` 做委托签名调用（创建授权意图、查询状态、发起任务）。

你不需要接触 Desktop 的 device token，不需要管连接，也不需要复刻任何状态推导。

---

## 0. 获取 SDK

> ⚠️ **`@panda-bridge/sdk` 目前未发布到 npm。直接 `npm install @panda-bridge/sdk` 会撞 `E404`。** 用下面两种方式之一引入。

**方式 A · 本地 file: 路径**（同 monorepo 或本地 checkout 最省事）：

```json
{
  "dependencies": {
    "@panda-bridge/sdk": "file:../panda-bridge/packages/sdk"
  }
}
```

**方式 B · git 依赖**（指向私有仓库 / 子目录）：

```bash
npm install "git+ssh://git@<your-host>/panda-bridge.git#dev"
# 或在 package.json 里固定到某个 commit：
#   "@panda-bridge/sdk": "git+https://<token>@<host>/panda-bridge.git#<sha>"
```

> SDK 是纯 ESM，依赖 WebCrypto（`globalThis.crypto.subtle`）；Node ≥ 18、Workers、现代浏览器都满足。无第三方运行时依赖。

导入方式：

```js
import { createBridgeClient } from "@panda-bridge/sdk";           // 浏览器/前端
import { createBridgeServerClient } from "@panda-bridge/sdk/server"; // 后端委托签名
```

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

> **前置条件**（否则下面的请求会 401 / 403）：①浏览器已有有效 Bridge 会话（`bridge.auth.*` 登录后带 `pb_session` cookie，`createBridgeClient` 默认 `credentials: "include"`）；②请求来自该产品**注册过的 origin**（见 §7），否则返回 `invalid_origin`。

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

// 3. 三个用户动作（账号级——不必指定设备；后端按 (账号, 产品) 解析当前授权设备）
await bridge.authorization.pause({ accountId });   // 暂停
await bridge.authorization.resume({ accountId });  // 恢复
await bridge.authorization.remove({ accountId });  // 删除（remove 后该账号从 state.accounts 消失）

// 也支持精确到某台设备（多 Mac 时）：传 deviceId 即按设备处理。
// await bridge.authorization.pause({ deviceId });
```

> **账号级 vs 设备级**：`pause/resume/remove` 既可只传 `accountId`（或干脆什么都不传，按当前会话账号 + 产品解析），也可传 `deviceId` 精确到设备。不指定设备时，后端解析该 `(账号, 产品)` 当前 active/paused 的授权设备并作用其上；真的没有任何授权设备时返回 `product_not_authorized`（不是 `device_not_found`）。

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

// 授权管理（账号级——只传 userId 即可，后端按 (账号, 产品) 解析授权设备）
await bridge.authorization.pause({ userId: user.id });
await bridge.authorization.resume({ userId: user.id });
await bridge.authorization.remove({ userId: user.id }); // remove 后该账号从 state().accounts 消失

// 多 Mac 时可精确到设备：
// await bridge.authorization.pause({ userId: user.id, deviceId });
```

`userId` 是你自己产品侧的用户 ID；Bridge 内部按产品命名空间隔离，不同产品的同名 `userId` 互不相干。

> **`deviceId` 是可选的。** 不传时 server client 在签名里用约定占位 `"account"`，后端据此解析该 `(账号, 产品)` 当前 active/paused 的授权设备；传了具体 `deviceId` 就按设备处理。没有任何授权设备时返回 `product_not_authorized`。

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

### 委托端点路径表（以 `apps/cloud-worker/src/index.js` 实际路由为准）

`<id>` = 你的 `product_id`。手写签名时第 2 行 path 必须**含 query**。

| 用途 | 方法 + 路径 | SDK 方法 | 签名设备占位 |
| --- | --- | --- | --- |
| 账号级状态 | `GET /v1/products/<id>/delegated/state` | `state({ userId })` | `account` |
| 创建连接意图 | `POST /v1/products/<id>/delegated/connect-intents` | `createConnectIntent({ userId, … })` | `pending` |
| 查询连接意图 | `GET /v1/products/<id>/delegated/connect-intents/<token>` | `intentStatus(token, { userId })` | `pending` |
| 暂停/恢复授权 | `PATCH /v1/products/<id>/delegated/authorization` | `authorization.pause/resume({ userId })` | `account`（或具体 deviceId） |
| 删除授权 | `DELETE /v1/products/<id>/delegated/authorization` | `authorization.remove({ userId })` | `account`（或具体 deviceId） |
| 查询授权（需具体设备） | `GET /v1/products/<id>/delegated/authorization?device_id=<dev>` | — | 必须 = 该 deviceId |
| 创建任务 | `POST /v1/products/<id>/delegated/jobs` | `createJob({ userId, deviceId, … })` | 必须 = 该 deviceId |
| 取任务事件 | `GET /v1/products/<id>/delegated/jobs/<jobId>/events?after=<seq>` | `jobEvents(jobId, { userId, deviceId, after })` | 该 deviceId |
| 读取单个任务 | `GET /v1/products/<id>/delegated/jobs/<jobId>` | — | 该 deviceId |
| 取消任务 | `POST /v1/products/<id>/delegated/jobs/<jobId>/cancel` | — | 该 deviceId |

> `PATCH`/`DELETE /authorization` **支持账号级**：不带 `?device_id`（签名设备用 `account` 占位）时，后端解析该 `(账号, 产品)` 的授权设备；带 `?device_id=<dev>` 时按设备处理，且 query 里的 device_id 必须与签名设备一致，否则 `delegated_device_mismatch`。`jobs` / `authorization` GET 仍要求具体设备。

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

### 怎么从 events 取回复文本

每个事件是 `{ job_id, seq, type, payload, created_at }`。任务完成时会有一条 `type: "completed"` 事件，其 `payload` 就是桌面端 ack 上来的 `result`（连接器 ack `result: { ok, reply, … }`）。取最终回复：

```js
const events = await bridge.jobEvents(created.job.id, { userId: user.id, deviceId });
const completed = events.items.find((e) => e.type === "completed");
const reply = completed?.payload?.reply ?? null;       // 最终回复文本
// 流式增量在 text_delta 事件里：
const stream = events.items.filter((e) => e.type === "text_delta").map((e) => e.payload.delta).join("");
// 失败：type === "failed"，payload.error 是失败原因（可能是 local_policy_denied）。
```

事件类型：`queued → claimed → started → text_delta*（流式）→ completed`（或 `failed` / `cancelled`）。轮询用 `after=<上次最大 seq>` 取增量。

### 链路断点排查

- codex 调用在**设备未知**（deviceId 不存在/已撤销）时先返回 `device_not_found`，**不是** `product_not_authorized`——别把这两个混为一谈：前者是「没这台设备」，后者是「这台设备没 active 授权」。设备在线但未授权 → `product_not_authorized`；授权被暂停 → `authorization_paused`；设备离线 → `device_offline`。
- `remove` 之后，该账号**从 `state().accounts` 消失**（不是变成 `revoked` 残留在列表里）。所以渲染空态的判断是 `accounts.length === 0`，而不是去找 `status === "revoked"`。

---

## 5. 错误码全表

所有 SDK 请求失败时抛出 `BridgeError`，带 `error.status`（HTTP）、`error.code`、`error.payload`。

### 授权 / 连接类

| Code | HTTP | 含义 | 怎么处理 |
| --- | --- | --- | --- |
| `authorization_paused` | 403 | 该账号授权被用户暂停 | 引导用户「恢复授权」，不要重发意图 |
| `authorization_revoked` | 409 | 对已删除（revoked）授权做 pause/resume | 重新走第 4 节授权请求流程 |
| `product_not_authorized` | 403 | 该产品对此账号无 active 授权（含账号级动作找不到授权设备） | 走第 4 节授权请求流程 |
| `already_authorized` | 200 | 已授权的幂等快路径 | 直接进入就绪态，不显示授权按钮 |
| `invalid_connect_intent` | 400 | 意图不存在、已消费或过期 | 重新创建 connect intent |
| `desktop_claim_required` | 403 | 浏览器尝试 claim 原生意图 | 移除浏览器侧 claim 代码；claim 只能桌面端做 |
| `device_not_found` | 404 | 设备不存在或已撤销（设备未知时优先于 product_not_authorized） | 刷新设备 / 重新走授权流程 |
| `device_offline` | 409 | 目标设备当前离线（正在重连） | 等待自动重连，不要重发授权 |

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
| `unsupported_job_kind` | 400 | `kind` 不在 Bridge 支持的任务类型集内 | 用受支持的 kind（codex.chat / codex.run / codex.rpc / saas.custom.run） |
| `scope_insufficient` | 403 | kind 不在该产品能力范围内 | 用该产品已注册能力内的 kind |
| `idempotency_key_conflict` | 409 | 同 requestKey 但 body 不同 | 换新的 requestKey，或确保 body 一致 |
| `request_body_too_large` | 413 | JSON body 超限 | 缩小请求 |
| `invalid_json` | 400 | body 不是合法 JSON | 修正序列化 |
| `invalid_content_type` | 415 | 写请求不是 JSON | 设置 `content-type: application/json` |
| `not_found` | 404 | 路径/资源不存在（路由未命中等） | 核对请求路径与方法 |
| `unauthorized` | 401 | 无有效会话 | 让用户登录 |

> SDK 还导出 `BridgeErrorCodes`（机器码常量）与 `BRIDGE_ERROR_MESSAGES`（码→中文可读说明）。`BridgeError.code` 始终是原始机器码；`BridgeError.message` 在 worker 未回 `message` 时按码填一句可读说明（不再等于 code）。

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

## 7. 本地开发（in-process worker，零外部依赖）

不需要起真实服务器：Cloud Worker 是一个标准 `fetch` handler，可直接 `import` 进你的测试/脚本，用内存存储跑通整条链路。`examples/minimal-caller/run-local.mjs` 就是这么做的。

```js
import worker from "@panda-bridge/cloud-worker"; // 本仓内为 apps/cloud-worker/src/index.js
import { createBridgeServerClient } from "@panda-bridge/sdk/server";

const apiBase = "http://localhost.test";
const env = {
  BRIDGE_LOCAL_MEMORY: "1",                                  // 用内存存储（不连 Supabase）
  BRIDGE_WEB_ORIGIN: apiBase,                                // 浏览器写请求允许的来源（cookie Secure 也据此判定）
  BRIDGE_PUBLIC_API_BASE: apiBase,                           // 回链给客户端的公网 API base（deep_link 等用）
  SESSION_COOKIE_NAME: "pb_session",                         // 会话 cookie 名（默认 pb_session）
  BRIDGE_OTHERLINE_DELEGATION_SECRET: "dev-otherline-secret",// 该产品的委托 secret（命名见下）
  BRIDGE_PRODUCT_ALLOWED_ORIGINS: JSON.stringify({ otherline: [apiBase] }), // 各产品的 origin 白名单
};

// SDK 只看到一个普通 fetch；这里把请求喂给 worker.fetch。
const bridge = createBridgeServerClient({
  apiBase,
  productId: "otherline",
  secret: env.BRIDGE_OTHERLINE_DELEGATION_SECRET,
  fetch: (url, init = {}) => worker.fetch(
    new Request(url, { method: init.method || "GET", headers: new Headers(init.headers || {}), body: init.body }),
    env,
  ),
});
```

### 六个关键 env（逐个）

| env | 作用 |
| --- | --- |
| `BRIDGE_LOCAL_MEMORY` | 设为 `"1"` 用进程内内存存储；不设且配了 Supabase 时走 Supabase。本地开发/测试一律设 `"1"`。 |
| `BRIDGE_WEB_ORIGIN` | 桌面壳/控制台的 Web 来源。决定浏览器写请求的允许来源，以及会话 cookie 是否带 `Secure`（`https://` 才加）。 |
| `BRIDGE_PUBLIC_API_BASE` | 对外公网 API base，用于回链（如 connect intent 的 `deep_link` 里的 `api=`）。本地填你的 `apiBase`。 |
| `SESSION_COOKIE_NAME` | 浏览器会话 cookie 名，默认 `pb_session`。 |
| `BRIDGE_<大写PRODUCTID>_DELEGATION_SECRET` | 单个产品的委托 HMAC secret，见下方命名约定。 |
| `BRIDGE_PRODUCT_ALLOWED_ORIGINS` | JSON，`{ "<productId>": ["<origin>", …] }`，每个产品的浏览器 origin 白名单；不在表内 → `invalid_origin` / `product_origin_mismatch`。 |

### secret 环境变量命名约定

- **单产品变量**：`BRIDGE_<大写PRODUCTID>_DELEGATION_SECRET`。productId 取**大写**，例如 `otherline` → `BRIDGE_OTHERLINE_DELEGATION_SECRET`、`pandart` → `BRIDGE_PANDART_DELEGATION_SECRET`。
- **集中 JSON 变量**（多产品一处配）：`BRIDGE_PRODUCT_DELEGATION_SECRETS = {"<productId>":"<secret>", …}`（注意里面的 key 用原始小写 productId）。
- 两者都配时，单产品变量优先。secret 只放后端 / Worker，绝不进前端。

### 在测试里模拟桌面 claim（connector 端点）

委托流程的「桌面端确认」那一步，本地用 **public connector API** 模拟。浏览器永远不能 claim（会 `desktop_claim_required`），要带本地客户端头：

```js
// 后端先建意图（SDK 帮你签名）
const intent = await bridge.createConnectIntent({ userId, account: { display_name: "Dev" }, deviceName: "Dev Mac" });

// 模拟桌面端原生 claim：带 x-panda-bridge-local-client + install_id
const claimRes = await worker.fetch(new Request(`${apiBase}/v1/connect-intents/${encodeURIComponent(intent.token)}/claim`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-panda-bridge-local-client": "connector-cli", // 标记本地桌面客户端
    "x-panda-bridge-install-id": "dev-install-id",   // install_id 必填，缺失 → install_id_required
  },
  body: JSON.stringify({ device_name: "Dev Mac", install_id: "dev-install-id", capabilities: { codex: ["codex.chat"] } }),
}), env);
const claim = await claimRes.json(); // claim.device.id / claim.device_token
```

claim 成功后该 `(产品, 账号)` 授权变 `active`，设备上线。之后用 `claim.device_token` 当连接器（GET `/v1/connectors/jobs` 取队列、POST `…/events`、`…/ack` 回结果）就能闭环跑完一个 codex 任务——完整可运行示例见 `examples/minimal-caller/run-local.mjs`。

---

## 8. 注册产品（前置 + 下一步）

接入前需要在 Bridge Cloud 为你的产品登记三样东西：

- `product_id`：稳定 ID，例如 `otherline`、`pandart`。
- official origins：产品真实浏览器来源（写进 `BRIDGE_PRODUCT_ALLOWED_ORIGINS`）；浏览器请求必须来自该产品自己的 origin。
- delegation secret：服务端 HMAC secret（按上面的命名约定配成 env），只放后端 / Worker。

**实际下一步怎么做**：

1. **本地自助先跑通**（推荐先做）：按 §7 用 in-process worker + 自己的 productId/secret/origin 把整条链路（建意图 → 模拟 claim → 任务 → events）在本地验证一遍，确认接入代码无误，再申请线上。`examples/minimal-caller/` 是现成模板，改 `productId` / secret / origin 即可。
2. **申请线上登记**：把 `product_id`、official origins、以及希望使用的 delegation secret（或请云端代生成）提交给 Bridge Cloud 维护者，由其写入云端的 `BRIDGE_<PRODUCT>_DELEGATION_SECRET`（或 `BRIDGE_PRODUCT_DELEGATION_SECRETS`）与 `BRIDGE_PRODUCT_ALLOWED_ORIGINS`。当前没有自助注册门户。
3. **联系方式 / 入口**：通过本仓库 issue 或团队内部渠道联系 Bridge 维护者；登记完成后云端 `product_delegation_not_configured` 即消失，委托调用可用。

参考实现：Worker 的委托签名校验在 `apps/cloud-worker/test/worker.test.mjs`（`delegatedApiRawText`），8 字段顺序与本文逐字段一致；委托端点路径见 §3 路径表。
