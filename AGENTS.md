# Panda Bridge Agent 规则

后续开发默认只在 `main` 分支进行。

## 核心边界

- Bridge 是通用 Cloud-to-Local Secure Relay / Jump Host，只做账号设备接入、presence、密文 envelope 中继、ACK/cursor/TTL、撤销、诊断和 Adapter 路由。
- Bridge Cloud 不执行 Claude、Codex、Burn、shell、fs、data、Task、Issue、Doc、workspace 或任何产品业务逻辑。
- Bridge Desktop core 不解密产品业务明文，不理解产品 command schema，不持有产品会话密钥，不把产品 runtime 写成 core capability。
- `packages/sdk`、`packages/protocol`、`apps/cloud-worker` 和 Desktop core 只能承载通用 Bridge 能力；产品业务必须留在 Product Adapter 或产品自有包里。
- 新增 Burn、Codex、Claude、SSH、本机工具、workspace action 或其他垂直能力时，只能新增/更新对应 Product Adapter、adapter SDK 通用能力、打包 manifest、启动/健康检查和验证，不得把业务 handler 写进 Bridge core。

## Desktop 打包归属

- 用户电脑端需要运行的产品本地能力，可以随 Bridge Desktop 安装包一起分发和安装；用户体验上允许“装一个 Bridge Desktop 就具备产品 Connector 能力”。
- 随包分发不等于归属 Bridge core。安装包可以包含 `core + Product Adapter + product local tools`，但 core 只负责发现、注册、启动、健康检查和路由 opaque envelope。
- Product Adapter 负责产品端到端加密、业务协议、本机权限策略和调用本地工具；Bridge core 只把 envelope 按 `product_id` 交给 Adapter，并返回 Adapter 产出的 encrypted response envelope。
- 内置或随包的本地工具应按产品隔离放置，例如 `adapters/<product>/`、`tools/<product>/` 或等价 manifest 声明；不得散落进 Bridge core 模块。
- Burn 需要的 `burn` backend/CLI、Task/Issue/Doc/Resource store、Codex/Claude profile scanner、Codex app-server launcher、Claude SDK runner 等，可以随 Bridge Desktop 打包，但逻辑归 Burn Adapter/Burn 工具包所有。
- Codex CLI、Claude Code、用户账号和本机数据目录是用户电脑上的外部依赖/数据源；Bridge 可以让产品 Adapter 发现和调用，但不得把这些账号或业务数据变成云端或 core 状态。

## 数据与明文

- 云端只保存必要路由元数据和短期密文 envelope 状态，不建设产品业务数据库。
- 业务明文只允许出现在 Product App 和用户电脑本机 Product Adapter / 产品本地数据目录里。
- Desktop core 的日志、diagnostics、status 只能暴露通用连接/Adapter 健康信息，不输出产品业务 payload、密钥、账号 token、本地文件正文或 AI 对话正文。
