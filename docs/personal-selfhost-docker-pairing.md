# Panda Bridge 个人自托管 Docker 配对体验

权威 Spec：
`spec/L2/VersionImplementation/bridge-personal-selfhost-docker-pairing.json`。
本文只是人读摘要，不作为实现事实源。

本文档摘要下一版个人用户自托管体验。目标用户是个人用户，不是假设有公司管理员。

## 产品结论

第一版主推：

```text
Docker 启动 Bridge Server -> 生成 Pairing Token -> Desktop 输入 Server URL + Token -> 配对成功 -> 后续连接走用户自己的服务器
```

不主推账号密码。账号密码、SSO、官方账号联邦登录后续再做。

## 用户最终体验

用户仍然像现在一样用产品：

1. 打开 App。
2. 登录产品账号。
3. 点击连接本地电脑。
4. Bridge Desktop 弹授权确认。
5. 用户点 Allow。
6. App 连接到本机。

区别只在中间 Bridge 服务：

- 官方模式：走 Panda 官方 Bridge Server。
- 自托管模式：走用户自己的 Docker Bridge Server。

产品列表不由自托管服务器注册出来。Bridge Desktop 始终展示固定的 Panda 产品目录，
例如 Burn；`My Server` 只决定这些产品的 Bridge 授权、presence 和 relay 走哪一台服务器。

## 服务器端体验

用户在自己的 VPS / NAS / 家里小主机上执行：

```bash
export BRIDGE_SELFHOST_ADMIN_TOKEN="$(openssl rand -hex 32)"
export BRIDGE_SERVER_URL="http://127.0.0.1:8787"
docker compose up -d
```

`BRIDGE_SERVER_URL` 可以是个人 VPS 的公网 `http://IP:PORT`，例如
`http://YOUR_SERVER_IP:18787`。生产长期公开使用时建议后续再加域名和
HTTPS/TLS，但第一版个人 Docker 配对不把 TLS 作为前置条件。

启动后显示：

```text
Server URL: http://127.0.0.1:8787
Pairing Token: XXXX-XXXXXX
Expires: 2026-06-19T00:00:00.000Z
```

如果用户忘了配对码，或者想重新生成：

```bash
docker compose exec bridge-server node scripts/selfhost/bridge-server.mjs pair
```

输出：

```text
Server URL: http://127.0.0.1:8787
Pairing Token: YYYY-YYYYYY
Expires: 2026-06-19T00:00:00.000Z
```

本地不使用 Docker 时，同一个命令包装器也可以直接跑：

```bash
BRIDGE_SELFHOST_ADMIN_TOKEN="$BRIDGE_SELFHOST_ADMIN_TOKEN" npm run bridge-server -- serve
npx --no-install bridge-server pair --url "$BRIDGE_SERVER_URL"
```

该入口只用于本机/自托管管理员生成一次性配对 Token；服务端写入的仍是
Token hash。`pair` 输出不会包含长期 device credential。

## Desktop 端体验

Bridge Desktop 增加服务器选择：

```text
Server
- Panda Official
- My Server
```

用户选择 `My Server` 后输入：

```text
Server URL
Pairing Token
```

点击连接后，Desktop 做检查：

1. URL 是否是合法 Bridge Server。
2. Pairing Token 是否正确。
3. Token 是否过期。
4. Token 是否可绑定这台 Desktop。

成功后：

- Desktop 保存这个 Server Profile。
- Desktop 获得长期 device credential。
- Pairing Token 立即失效。
- 之后该 Profile 的连接、授权和 relay 都走用户自己的服务器；产品目录仍是固定 Panda 产品目录。
- 个人自托管 Profile 允许 `http` 或 `https` Bridge API；官方默认云端仍使用
  `https://api.bridge.chaos-realms.cc`。

当前 Desktop headless 验证入口：

```bash
panda-bridge-desktop headless-pair-selfhost-profile --api "$SERVER_URL" --token "$PAIRING_TOKEN" --name "My Server"
```

## 授权逻辑

自托管不等于绕过授权。

仍然使用 Panda Bridge 的授权模型：

- Product App 创建 connect intent。
- Desktop 预览 intent。
- Desktop 弹授权确认。
- 用户点击 Allow。
- Server 记录 authorization active / paused / revoked。
- relay 只有在授权 active 时才能走。

区别是授权状态存在哪里：

- 官方 Profile：授权状态存在 Panda 官方服务器。
- My Server Profile：授权状态存在用户自己的服务器。

## Pairing Token 规则

Pairing Token 是设备配对用的，不是长期密码。

规则：

- Docker 首次启动自动生成。
- `docker compose exec bridge-server node scripts/selfhost/bridge-server.mjs pair` 可以重新生成。
- 默认 15 分钟过期。
- 只能使用一次。
- 成功配对后换成长效 device credential。
- Desktop 不保存原始 Pairing Token。
- Server 只保存 Token hash，不保存明文 Token。

## 第一版不做

第一版不要做这些：

- 官方账号和自托管服务器账号打通。
- 用户名密码登录。
- SSO / OAuth / 企业租户。
- 多管理员后台。
- 复杂权限系统。
- 官方云和自托管之间同步授权状态。

第一版只保证：

> 用户能自己部署 Bridge Server，并用 Bridge Desktop 输入 Server URL + Pairing Token 配对。配对后，产品连接本机的体验和官方模式一致，只是 relay 服务走用户自己的服务器。

## 第一版验收

必须能证明：

1. `docker compose up -d` 后 Server 可用。
2. 文档里的 Docker/local pair 命令能显示新的 Pairing Token。
3. Desktop 能输入 Server URL + Pairing Token 并配对成功。
4. Token 过期、错误、重复使用都会失败。
5. 配对成功后 Desktop 保存 My Server Profile。
6. Product App 走同一套授权弹窗。
7. 用户点 Allow 后，端到端 relay 走自托管 Server。
8. Server 不看到业务明文。
9. 有 redacted evidence 证明全链路通过。
