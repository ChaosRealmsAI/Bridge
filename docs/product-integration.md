# Panda Bridge Product Integration

本文面向要从零接入 Panda Bridge 的 SaaS 产品。目标是：产品后端负责服务端委托签名，产品前端只渲染 `BRIDGE-STATE-v1` 和调用 `ensureReady()`，不接触 Desktop device token，也不复刻 Bridge 状态推导。

## 1. 注册产品

接入前先在 Bridge Cloud 注册：

- `product_id`：稳定 ID，例如 `otherline`、`panda-chat`、`panda-dev`、`panda-spec`。
- official origins：产品真实浏览器来源；浏览器请求必须来自该产品自己的 origin，不能借用全局 CORS allowlist。
- delegation secret：服务端 HMAC secret，只放在产品后端或 Worker secret 中。
- capabilities：当前 runtime 能力为 `codex.chat`、`codex.run`、`codex.rpc`、`saas.custom.run`。
- 默认或请求时传入的 `AUTH-SCOPE-v1` policy：用户会在 Desktop 授权页看到这份本机授权范围。

Bridge 记录的是：

```text
Panda account + product_id + desktop device + approved AUTH-SCOPE-v1
```

同一账号可以有多台 Mac；同一台 Mac 可以服务多个账号；每个 product 的授权独立撤销。

## 2. 服务端接入

产品后端使用 SDK server client。它负责 8 字段 HMAC、timestamp、nonce、body hash 和重放防护细节。

```js
import { createBridgeServerClient } from "@panda-bridge/sdk/server";

const bridgeServer = createBridgeServerClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "otherline",
  secret: process.env.PANDA_BRIDGE_DELEGATION_SECRET,
  fetch,
});

export async function bridgeStateForUser(user) {
  return bridgeServer.state({ userId: user.id });
}

export async function createBridgeJob(user, input) {
  const state = await bridgeServer.state({ userId: user.id });
  if (state.bridge_state !== "ready") return state;

  return bridgeServer.createJob({
    userId: user.id,
    deviceId: state.devices.find((device) => device.current)?.id,
    kind: "codex.chat",
    payload: { prompt: input.prompt },
    requestKey: input.requestKey,
    policy: {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      timeout_ms: 240000,
    },
  });
}
```

服务端常用调用：

```js
await bridgeServer.state({ userId });
await bridgeServer.createConnectIntent({ userId, deviceName, policy });
await bridgeServer.intentStatus(token, { userId });
await bridgeServer.authorization({ userId, deviceId });
await bridgeServer.revoke({ userId, deviceId });
await bridgeServer.createJob({ userId, deviceId, kind, payload, policy, requestKey });
await bridgeServer.jobEvents(jobId, { userId, deviceId, after });
await bridgeServer.account({ userId });
```

## 3. 前端接入

前端使用浏览器 client 获取单一状态机结果，不再自己组合 session/device/authorization/preflight。

```js
import { createBridgeClient } from "@panda-bridge/sdk";

const bridge = createBridgeClient({
  apiBase: "https://api.bridge.otherline.cc",
  productId: "otherline",
});

const state = await bridge.state();
renderBridgeState(state);

await bridge.ensureReady({
  openDeepLink(action) {
    if (action.deep_link || action.url) window.location.href = action.deep_link || action.url;
  },
});
```

前端规则：

- 只渲染 `bridge_state` 和 `actions`，不要二次推导。
- `ready` 时不显示“授权”按钮。
- `authorized_offline` 只显示“打开 Bridge”，不要创建授权 intent。
- `authorization_pending` 复用已有 intent 等待 Desktop 确认。
- 浏览器永远不调用 claim endpoint；claim 只能由 native Desktop 完成。

## 4. BRIDGE-STATE-v1

Cloud 对 `(account, product)` 计算唯一 `bridge_state`，web-chat、otherline、desktop、SDK 都以它为事实源。

| state | 判定，按优先级命中第一条 | 唯一 CTA |
| --- | --- | --- |
| `no_session` | 无有效会话 | 登录 |
| `no_device` | 该账号无任何非 revoked 设备 | 下载 Bridge（显示真实下载链接+版本）→ 打开后自动连接 |
| `authorization_pending` | 存在未过期未 claim 的 connect intent | 去桌面端确认（可重新唤起 deep link / 取消） |
| `authorized_offline` | 有 active authorization，但授权设备全部离线 | 打开 Bridge（`panda-bridge://open`），绝不显示“授权”按钮 |
| `not_authorized` | 有在线或离线设备，但该产品无 active authorization，含从未授权/已撤销/已过期 | 授权（创建 intent → deep link） |
| `ready` | active authorization && 授权设备在线 | 无 CTA；显示就绪态 + 设备名；换设备/撤销/刷新折叠为次要动作 |

同一响应给齐：

```js
{
  bridge_state: "ready",
  install: {
    download_url: "https://assets.bridge.otherline.cc/downloads/panda-bridge-macos.dmg",
    version: "1.0.0",
    sha256: "...",
    platform: "macos",
    open_url: "panda-bridge://open"
  },
  devices: [
    { id, name, online: true, last_seen_at, current: true }
  ],
  authorization: {
    status: "active",
    policy: { version: "AUTH-SCOPE-v1" },
    authorized_at,
    origin
  },
  intent: null,
  actions: []
}
```

`authorized_offline` 与 `not_authorized` 不等价。前者已经授权，只需要打开 Desktop；后者才需要授权。

## 5. 授权与重授权语义

创建 intent 时传入调用方需要的 `AUTH-SCOPE-v1`：

```js
await bridgeServer.createConnectIntent({
  userId,
  deviceName: "User Mac",
  policy: {
    version: "AUTH-SCOPE-v1",
    capabilities: ["codex.chat", "codex.run"],
    workspace_roots: [{ id: "all", allow_all: true, path_display: "All local files" }],
    sandbox_floor: "danger-full-access",
    approval_policy_floor: "never",
    allow_approval_never: true,
    allow_developer_instructions: true,
  },
});
```

规则：

- 已授权且设备在线，且已批准 scope 覆盖请求 scope：返回 `already_authorized:true` 和 `ready`，不创建 intent。
- 已授权但设备离线：返回 `authorized_offline`，只打开 Bridge。
- scope 不变宽的重复授权：Desktop 显示轻确认或刷新连接。
- scope 变宽：Desktop 必须显示完整授权确认和 scope diff。
- intent 过期：`authorization_pending` 回落到 `not_authorized`，用户可重新发送。
- revoke 后：状态立即变为 `not_authorized` 或 `no_device`；queued/running job 的取消与 late ack 拒绝遵循 runtime revocation BDD。

## 6. 错误码

| Code | HTTP | Meaning | Product action |
| --- | --- | --- | --- |
| `not_authenticated` | 401 | 无 Bridge session | 让用户登录 |
| `no_session` | 200/state | 状态机无有效会话 | 渲染登录 CTA |
| `no_device` | 200/state | 账号没有非 revoked Desktop | 渲染下载 CTA |
| `authorization_pending` | 200/state | 有未过期未 claim intent | 等待 Desktop 确认 |
| `authorized_offline` | 200/state | 已授权但授权设备离线 | 打开 Bridge |
| `not_authorized` | 200/state | 有设备但产品未授权 | 发起授权 |
| `ready` | 200/state | 已授权且设备在线 | 允许创建 job |
| `already_authorized` | 200 | 幂等授权快路径 | 直接进入 ready，不显示 deep link |
| `install_id_required` | 400 | Desktop claim 缺少 install_id | Desktop 修复并重试；产品继续 pending/重试 |
| `install_identity_mismatch` | 401 | device token 与 install_id 不匹配 | 要求 Desktop 重新连接 |
| `desktop_claim_required` | 403 | 浏览器尝试 claim native intent | 移除浏览器 claim 代码 |
| `invalid_connect_intent` | 400 | intent 不存在、已消费或过期 | 重新创建 intent |
| `product_not_authorized` | 403 | 产品无 active authorization | 渲染授权流程 |
| `authorization_scope_denied` | 403 | Cloud 发现 job 明显超过已批准 scope | 重新授权更宽 scope 或缩小 job policy |
| `local_policy_denied` | job result | Desktop 本地拒绝越权 job | 重新授权或缩小本地请求 |
| `scope_insufficient` | 403 | job kind 超出产品注册能力 | 修正产品注册或 job kind |
| `product_origin_mismatch` | 403 | Origin 与 product_id 不匹配 | 使用注册 origin 或测试 origin mapping |
| `invalid_authorization_policy` | 400 | AUTH-SCOPE-v1 格式或 capability 不合法 | 修正 policy |
| `device_not_found` | 404 | device 不存在或 revoked | 重新选择设备/重新授权 |
| `device_offline` | 409 | 目标设备离线 | 打开 Desktop 或切换设备 |
| `delegated_device_mismatch` | 403 | 委托签名中的 device 与请求对象不一致 | 使用正确 deviceId |
| `authorization_import_proof_required` | 400 | 委托导入授权缺 proof token | 先创建/传递 proof |
| `invalid_authorization_import_proof` | 409 | proof 缺失、过期或已消费 | 重新创建 proof |
| `delegated_authorization_proof_mismatch` | 403 | proof 不属于签名 user/device | 修正 userId/deviceId |
| `product_delegation_not_configured` | 503 | 产品 secret 未配置 | 配置 Worker secret |
| `product_delegation_unauthorized` | 401 | 委托签名头缺失或身份无效 | 修正服务端 client 配置 |
| `product_delegation_timestamp_invalid` | 401 | timestamp 超出允许偏移 | 同步时钟并重签 |
| `product_delegation_body_hash_invalid` | 401 | body hash 与请求体不一致 | 按实际 body 重算 hash |
| `product_delegation_signature_invalid` | 401 | HMAC 输入或 secret 不匹配 | 核对 8 字段，尤其 path 含 query |
| `product_delegation_replay` | 401 | nonce 已使用 | 使用新的 nonce 重试 |
| `request_body_too_large` | 413 | JSON body 超限 | 缩小请求 |
| `invalid_json` | 400 | body 不是合法 JSON | 修正请求 |
| `invalid_content_type` | 415 | 写请求不是 JSON | 设置 `content-type: application/json` |

SDK 错误暴露 `error.status`、`error.payload`、`error.code`。

## 7. 委托签名附录

Worker 参考实现位于 `apps/cloud-worker/test/worker.test.mjs:110-135`。签名 payload 必须逐字段、逐行拼接：

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

字段说明：

- `METHOD`：大写 HTTP method，例如 `POST`。
- `path含query`：URL path 加 query，例如 `/v1/products/otherline/delegated/jobs?after=10`。漏掉 query 会签名失败。
- `productId`：注册产品 ID。
- `userId`：产品侧用户 ID；Bridge 内部会按 product namespace 隔离。
- `deviceId`：目标 device ID；不适用时仍使用 SDK 对应方法要求的值。
- `timestamp`：ISO 字符串；超出允许 skew 返回 `product_delegation_timestamp_invalid`。
- `nonce`：每次请求唯一；同 product 重放返回 `product_delegation_replay`。
- `bodySha256`：请求 body 原文的 SHA-256 hex；GET/空 body 使用空字符串的 hash。

请求头：

```text
x-panda-bridge-product-id: <productId>
x-panda-bridge-user-id: <userId>
x-panda-bridge-device-id: <deviceId>
x-panda-bridge-request-timestamp: <timestamp>
x-panda-bridge-request-nonce: <nonce>
x-panda-bridge-body-sha256: <bodySha256>
x-panda-bridge-signature: <hmacSha256Hex>
content-type: application/json
```

Node 级签名示例：

```js
import { createHash, createHmac, randomUUID } from "node:crypto";

const method = "POST";
const path = "/v1/products/otherline/delegated/jobs?trace=1";
const bodyText = JSON.stringify({
  device_id: "dev_123",
  kind: "codex.chat",
  input: { prompt: "Reply OK" },
});
const productId = "otherline";
const userId = "user_123";
const deviceId = "dev_123";
const timestamp = new Date().toISOString();
const nonce = randomUUID();
const bodySha256 = createHash("sha256").update(bodyText).digest("hex");

const signingPayload = [
  method.toUpperCase(),
  path,
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

curl 级请求示例：

```bash
curl "https://api.bridge.otherline.cc/v1/products/otherline/delegated/jobs?trace=1" \
  -X POST \
  -H "content-type: application/json" \
  -H "x-panda-bridge-product-id: otherline" \
  -H "x-panda-bridge-user-id: user_123" \
  -H "x-panda-bridge-device-id: dev_123" \
  -H "x-panda-bridge-request-timestamp: 2026-06-11T12:00:00.000Z" \
  -H "x-panda-bridge-request-nonce: 0198f0f4-0c8e-7b85-9f12-demo" \
  -H "x-panda-bridge-body-sha256: <sha256-of-body>" \
  -H "x-panda-bridge-signature: <hmac-sha256-hex>" \
  --data '{"device_id":"dev_123","kind":"codex.chat","input":{"prompt":"Reply OK"}}'
```

生产代码应优先使用 `createBridgeServerClient`，手写签名只用于诊断或非 JS 后端移植。
