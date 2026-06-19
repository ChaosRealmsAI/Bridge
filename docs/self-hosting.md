# Panda Bridge 自托管

个人用户自托管的下一版权威 Spec 是
`spec/L2/VersionImplementation/bridge-personal-selfhost-docker-pairing.json`。
人读摘要见
[personal-selfhost-docker-pairing.md](personal-selfhost-docker-pairing.md)：
Docker 启动后生成 Pairing Token，Bridge Desktop 输入 Server URL +
Pairing Token 完成配对。本文档下面保留当前 Cloudflare Worker +
Supabase 部署说明。

自托管时，用户维护的是自己的 Bridge Cloud：账号、设备、授权、presence、密文 relay envelope、ack/status 和短期队列。Bridge Cloud 仍然不执行业务能力，也不解密业务内容；产品自己的 Product App / Product Backend 和本机 Product Adapter 负责端到端加密与业务协议。自托管服务器是 Bridge 级别的连接服务，不是产品列表来源；Bridge Desktop 的产品列表始终来自固定 Panda 产品目录。

## 1. 个人 Docker 快速启动

本仓库现在提供一个个人自托管的 Docker/compose 入口。它运行同一个通用
Bridge Worker fetch 处理器，只在容器里用 Node HTTP wrapper 暴露本地服务。
默认 `BRIDGE_LOCAL_MEMORY=1`，适合本机、NAS 或内网快速试跑；容器重建后内存
状态会丢失。需要持久化生产自托管时，继续使用下一节的 Cloudflare Worker +
Supabase 路线。

先准备一个只给本机管理员生成 Pairing Token 用的 token。不要提交到仓库：

```bash
export BRIDGE_SELFHOST_ADMIN_TOKEN="$(openssl rand -hex 32)"
export BRIDGE_SERVER_URL="http://127.0.0.1:8787"
docker compose up -d
```

个人 VPS 可以直接把 `BRIDGE_SERVER_URL` 设置成公网
`http://IP:PORT`，例如 `http://YOUR_SERVER_IP:18787`。Bridge Desktop 的
自托管配对入口支持 `http` 和 `https`。长期生产公开使用建议再加域名和
HTTPS/TLS，但它不是第一版 Docker 配对的前置条件。

启动日志会打印：

```text
Server URL: http://127.0.0.1:8787
Pairing Token: XXXX-XXXXXX
Expires: 2026-06-19T00:00:00.000Z
```

需要重新生成一次性 Pairing Token 时：

```bash
docker compose exec bridge-server node scripts/selfhost/bridge-server.mjs pair
```

本地不用 Docker 时可以直接跑同一个命令包装器：

```bash
BRIDGE_SELFHOST_ADMIN_TOKEN="$BRIDGE_SELFHOST_ADMIN_TOKEN" npm run bridge-server -- serve
npx --no-install bridge-server pair --url "$BRIDGE_SERVER_URL"
```

`pair` 只打印 `Server URL`、`Pairing Token` 和 `Expires`，不打印长期
device credential。Pairing Token 默认 15 分钟过期，成功配对后只能使用一次。

## 2. Cloudflare Worker + Supabase 部署方式

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
- `BRIDGE_PRODUCT_REGISTRY_JSON`：高级服务端产品 registry，仅用于 diagnostics、allowlist 和测试服务端；不是 Desktop 产品目录。
- `BRIDGE_PRODUCT_ALLOWED_ORIGINS`：允许哪些产品网页 origin 调 API。

Supabase 迁移使用仓库现有迁移：

```bash
SUPABASE_DB_URL='postgres://...' npm run cloud:migrate
```

生产/自托管环境必须配置持久化存储。`BRIDGE_ENV=production` 或
`BRIDGE_ENV=selfhost` 时，如果没有 Supabase service role secret 或等价持久化
store，`GET /v1/health` 会返回 `503 bridge_storage_unconfigured`，写入类 API
不会静默落到内存。

首次部署前设置 secrets：

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config apps/cloud-worker/wrangler.selfhost.toml
wrangler secret put BRIDGE_PRODUCT_DELEGATION_SECRETS --config apps/cloud-worker/wrangler.selfhost.toml
```

部署：

```bash
npx wrangler deploy --config apps/cloud-worker/wrangler.selfhost.toml
```

仓库内的真实验证入口是：

```bash
npm run verify:selfhost-profile
npm run verify:selfhost-docker-cli
```

## 3. 产品目录与诊断

Bridge Desktop 不从自托管服务器注册产品。用户切换到 My Server 后，左侧仍显示固定
Panda 产品，例如 Burn；My Server 只改变这些产品使用的 Bridge API。

`/v1/diagnostics` 用于证明这是兼容的 Bridge Server，并暴露 relay 能力、队列限制、
存储状态等运行信息。diagnostics 里的 `products` 字段只服务服务端兼容性和高级调试，
不能作为 Desktop 产品目录的事实源。

## 4. 高级服务端产品配置

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

高级模式：

- `builtin`：只使用官方内置产品，默认值。
- `replace`：只使用你配置的服务端产品 registry。当前 Panda Bridge Desktop 不把它当作产品目录，主要用于高级/测试服务端。
- `extend`：保留官方产品，只追加新的自定义产品 ID；如果自定义产品使用内置产品 ID，Worker 会返回 `invalid_product_registry_config`，不会覆盖官方产品。

自托管产品目前只获得 relay 能力：`relay.envelope` 和 `relay.ack`。Bridge core 不会因为 registry 增加 shell、fs、Codex 等垂直能力。

## 5. 桌面端连接

用户在 Panda Bridge Desktop 的设置里添加服务器：

```text
https://api.bridge.example.com
```

桌面端会先访问：

```text
GET /v1/health
GET /v1/diagnostics
```

只有 health/diagnostics 证明这是兼容 Bridge Server 后，Profile 才会保存。选中这个
Profile 后，左侧产品列表仍展示固定 Panda 产品目录；Profile 只切换 Bridge API。

产品创建 connect intent 后，打开 deep link：

```text
panda-bridge://connect?api=https%3A%2F%2Fapi.bridge.example.com&intent=<token>
```

Desktop 会向这个 API claim intent，并把该 API 自动登记为服务器 Profile。

## 6. 本机 Product Adapter

你的本机 Adapter 接收 Desktop 转发的 opaque relay envelope：

```text
PANDA_BRIDGE_ADAPTER_ACME_DEMO_URL=http://127.0.0.1:4567/v1/relay-envelope
```

规则：

- env 名按产品 id 大写，非字母数字转 `_`：`acme-demo` -> `PANDA_BRIDGE_ADAPTER_ACME_DEMO_URL`。
- Adapter 自己解密、执行业务、再加密 response envelope。
- Adapter 必须做幂等：同一个 inbound envelope id 或 request key 重试时，返回同一份 response envelope，不重复执行本机动作。

## 7. 验证

本地完整验证：

```bash
npm run verify:selfhost-profile
```

它会启动一个本地自托管 Worker，用 headless Desktop 添加并选中服务器 Profile，确认固定产品目录仍显示 Burn，完成授权，再通过产品 Adapter 路由跑一条加密 relay `pwd` 请求。

证据输出：

```text
spec/L3/evidence/selfhost-profile/summary.json
```
