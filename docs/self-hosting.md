# Panda Bridge 自托管

自托管时，用户维护的是自己的 Bridge Cloud：账号、设备、授权、presence、密文 relay envelope、ack/status 和短期队列。Bridge Cloud 仍然不执行业务能力，也不解密业务内容；产品自己的 Product App / Product Backend 和本机 Product Adapter 负责端到端加密与业务协议。

## 1. 部署方式

推荐生产方式是 Cloudflare Worker，不需要 Docker：

```bash
cp apps/cloud-worker/wrangler.selfhost.example.toml apps/cloud-worker/wrangler.selfhost.toml
npm install
npm run build:web
```

编辑 `apps/cloud-worker/wrangler.selfhost.toml`：

- `account_id`：你的 Cloudflare account id。
- `routes`：你的 API/Web/Assets 域名，例如 `api.bridge.example.com`。
- `SUPABASE_URL`：你的 Supabase project URL。
- `BRIDGE_WEB_ORIGIN`：你的 Bridge Web origin。
- `BRIDGE_PUBLIC_API_BASE`：你的 Bridge API base。
- `BRIDGE_PRODUCT_REGISTRY_JSON`：你维护的产品列表。
- `BRIDGE_PRODUCT_ALLOWED_ORIGINS`：允许哪些产品网页 origin 调 API。

Supabase 迁移使用仓库现有迁移：

```bash
SUPABASE_DB_URL='postgres://...' npm run cloud:migrate
```

首次部署前设置 secrets：

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config apps/cloud-worker/wrangler.selfhost.toml
wrangler secret put BRIDGE_PRODUCT_DELEGATION_SECRETS --config apps/cloud-worker/wrangler.selfhost.toml
```

部署：

```bash
npx wrangler deploy --config apps/cloud-worker/wrangler.selfhost.toml
```

本地试跑可以用 Node/脚本启动 Worker fetch 代理，不要求 Docker。仓库内的真实验证入口是：

```bash
npm run verify:selfhost-profile
```

如果你一定要放进 Docker，建议只把它当本地/内网试跑容器：容器里跑 `npm install` 和一个 Node HTTP wrapper，把请求转给 `apps/cloud-worker/src/index.js` 的 `worker.fetch()`。生产仍建议用 Cloudflare Worker，因为 Durable Object、assets binding、cron 和 Worker runtime 都是当前正式运行边界。

## 2. 产品注册表

最小产品 registry：

```json
{
  "products": [
    {
      "id": "acme-demo",
      "name": "Acme Demo",
      "official_origin": "https://app.example.com",
      "web_url": "https://app.example.com"
    }
  ]
}
```

Worker 变量：

```text
BRIDGE_PRODUCT_REGISTRY_MODE=replace
BRIDGE_PRODUCT_REGISTRY_JSON=<上面的 JSON 压缩成一行>
BRIDGE_PRODUCT_ALLOWED_ORIGINS={"acme-demo":["https://app.example.com","https://bridge.example.com"]}
```

模式：

- `builtin`：只使用官方内置产品，默认值。
- `replace`：只使用你配置的产品，适合完全自托管。
- `extend`：保留官方产品，只追加新的自定义产品 ID；如果自定义产品使用内置产品 ID，Worker 会返回 `invalid_product_registry_config`，不会覆盖官方产品。

自托管产品目前只获得 relay 能力：`relay.envelope` 和 `relay.ack`。Bridge core 不会因为 registry 增加 shell、fs、Codex 等垂直能力。

## 3. 桌面端连接

用户在 Panda Bridge Desktop 的设置里添加服务器：

```text
https://api.bridge.example.com
```

桌面端会先访问：

```text
GET /v1/health
GET /v1/diagnostics
```

只有 diagnostics 返回产品列表后，Profile 才会保存。选中这个 Profile 后，左侧产品 tab 会展示你的产品，而不是固定官方产品。

产品创建 connect intent 后，打开 deep link：

```text
panda-bridge://connect?api=https%3A%2F%2Fapi.bridge.example.com&intent=<token>
```

Desktop 会向这个 API claim intent，并把该 API 自动登记为服务器 Profile。

## 4. 本机 Product Adapter

你的本机 Adapter 接收 Desktop 转发的 opaque relay envelope：

```text
PANDA_BRIDGE_ADAPTER_ACME_DEMO_URL=http://127.0.0.1:4567/v1/relay-envelope
```

规则：

- env 名按产品 id 大写，非字母数字转 `_`：`acme-demo` -> `PANDA_BRIDGE_ADAPTER_ACME_DEMO_URL`。
- Adapter 自己解密、执行业务、再加密 response envelope。
- Adapter 必须做幂等：同一个 inbound envelope id 或 request key 重试时，返回同一份 response envelope，不重复执行本机动作。

## 5. 验证

本地完整验证：

```bash
npm run verify:selfhost-profile
```

它会启动一个本地自托管 Worker，声明 `acme-demo` 产品，用 headless Desktop 添加并选中服务器 Profile，完成授权，再通过 `PANDA_BRIDGE_ADAPTER_ACME_DEMO_URL` 跑一条加密 relay `pwd` 请求。

证据输出：

```text
spec/verification/evidence/selfhost-profile/summary.json
```
