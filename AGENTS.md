# Bridge Agent 规则

后续开发默认只在 `main` 分支进行。

## Desktop 启动与安装

- 给用户查看 Bridge Desktop 时，必须启动当前仓库源码构建出来的最新版桌面端；不得让旧的已安装 `Bridge.app`、后台 dev binary 或历史打包产物冒充当前版本。
- macOS 本机查看默认流程：先停止现有 `Bridge` / `bridge-desktop` 进程，再运行 `npm run desktop:install:mac` 重建并覆盖 `~/Applications/Bridge.app`，最后从这个 app bundle 启动。
- 如果发现多个已安装 Bridge app bundle，只保留当前仓库重建后的目标 app bundle；删除或隔离冗余安装前必须确认路径确实是 Bridge app bundle，不得清理用户数据、设置、凭证或非 Bridge 应用。
- Desktop 启动证据必须说明启动的是安装版还是 dev 版；除非用户明确要求调试 dev binary，给用户看的窗口一律以最新安装版为准。

## Desktop Release 与发包硬门

- Desktop public release 必须以 `release/desktop.json` 为唯一版本/下载合约；root `package.json`、`apps/desktop/package.json`、`apps/desktop/Cargo.toml`、SDK install defaults、Cloud Worker install payload、Mac/Windows 打包脚本都必须与该合约一致。
- 每个 Desktop release 必须同时声明 stable 下载链接和 versioned 下载链接：macOS DMG、Windows x64 zip、latest manifest、versioned manifest 都必须有固定路径。不得只给临时 dist 路径、旧安装包或手写 URL。
- `npm run check` 必须包含 `npm run check:release-contract`；提交前全局 hook 会调用 `scripts/check-commit.sh`，该脚本必须继续运行 release contract gate。改版本、打包脚本、SDK/Worker install payload 或下载链接时，不能绕过这个 gate。
- 真正 public release 前必须运行 `npm run release:desktop:prepare` 生成本地 Mac/Windows 产物和 manifest；Mac release 必须是 Developer ID hardened runtime 且 notarized/stapled，不得把 ad-hoc DMG 当正式 release。随后运行 `npm run release:desktop:verify` 校验本地产物大小、sha256 和 package summary。上传到公开资产后必须运行 `npm run release:desktop:audit-public`，确认公开链接不是 HTML fallback、大小达标、sha256 匹配。
- GitHub Latest 是公开下载主通道：`release/desktop.json` 的 `github` 段必须保持 `ChaosRealmsAI/Bridge`、`v<version>`、`releases/latest/download` 一致；发包或替换当前资产后运行 `npm run release:desktop:publish-current`，它会上传 stable/versioned asset 并执行 `npm run release:desktop:audit-github-latest`。Token Burn 落地页只允许指向这两个 Latest URL。
- `.github/workflows/bridge-desktop-release.yml` 是 Bridge Desktop GitHub Release 自动化入口；正式 macOS release 需要 GitHub secrets 提供 Developer ID certificate 和 notarization credentials。缺少这些 secrets 时，不得把 workflow 失败规避成 ad-hoc 正式包。
- Bridge Desktop 当前支持应用内检查 GitHub Latest 并打开对应平台下载；静默/自替换自动更新不算已支持，除非同时具备 Developer ID notarized macOS 包、签名 Windows 安装器/更新通道、回滚/前滚和黑盒证据。
- 上传/替换 `assets.bridge.chaos-realms.cc` 或其他公开下载资产属于 production/public release mutation，必须走 release-data-ops 发布硬门：release packet、影响面、dry-run/本地校验、上传命令、验证、回滚/前滚和证据齐全后才能执行。

## 环境隔离与发布门

- Bridge、Burn、Passport 的 local/test/production 契约以私有 Spec 和私有环境矩阵为准；这些文件不得进入公开仓。改 Cloud Worker、product registry、origin、storage 或发布脚本前，先在私有上下文核对环境事实，再同步脱敏后的公开说明和校验脚本。
- 生产、测试、本地必须成套切换：production Bridge 只接受 production Burn origin `https://token-burn.com`，test Bridge 只接受 test Burn origin `https://burn-test.chaos-realms.cc`；test registry 不得授权 `token-burn.com`，production config 不得指向 `api-bridge-test.chaos-realms.cc`。
- Bridge production storage 当前事实是 Durable Object：`BRIDGE_STORAGE_BACKEND=durable`、`BRIDGE_STORE`、`BRIDGE_STORE_NAME=bridge-production-store`。不得把 production Bridge 回退到过期 Supabase 项目或在 Spec 里继续记录 Supabase storage。
- 三端环境事实必须自维护：任何 Bridge API 域名、Worker 名、Durable Object、Burn product origin、delegation secret requirement、diagnostics 或 release script 变更，都要同步维护私有 Spec、私有公司环境矩阵、对应 devlog 和 `npm run check:env-contract`。
- 改动 Bridge/Burn/Passport 任一环境配置后，至少运行本仓 `npm run check:env-contract`，并在私有上下文运行 Burn/Passport 对应环境一致性检查；涉及生产 Bridge/Burn 还必须跑 Burn 严格 live audit。
- Bridge production deploy、custom domain/DNS、Durable Object 迁移、secret rotation、权限扩大和公开 release asset 上传都属于发布/数据停止门；没有用户明确确认时只能 dry-run 和只读审计。

## 核心边界

- Bridge 是通用 Cloud-to-Local Secure Relay / Jump Host，只做账号设备接入、presence、密文 envelope 中继、ACK/cursor/TTL、撤销、诊断和 Adapter 路由。
- Bridge Cloud 不执行 Claude、Codex、Burn、shell、fs、data、Task、Issue、Doc、workspace 或任何产品业务逻辑。
- Bridge Desktop core 不解密产品业务明文，不理解产品 command schema，不持有产品会话密钥，不把产品 runtime 写成 core capability。
- `packages/sdk`、`packages/protocol`、`apps/cloud-worker` 和 Desktop core 只能承载通用 Bridge 能力；产品业务必须留在 manifest 隔离的 Product Adapter / product local tools 目录或产品自有包里。
- 新增 Burn、Codex、Claude、SSH、本机工具、workspace action 或其他垂直能力时，只能新增/更新对应 Product Adapter、adapter SDK 通用能力、打包 manifest、启动/健康检查和验证，不得把业务 handler 写进 Bridge core。

## Desktop 打包归属

- 用户电脑端需要运行的产品本地能力，可以随 Bridge Desktop 安装包一起分发和安装；用户体验上允许“装一个 Bridge Desktop 就具备产品 Connector 能力”。
- 随包分发不等于归属 Bridge core。安装包可以包含 `core + Product Adapter + product local tools`，但 core 只负责发现、注册、启动、健康检查和路由 opaque envelope。
- Product Adapter 负责产品端到端加密、业务协议、本机权限策略和调用本地工具；Bridge core 只把 envelope 按 `product_id` 交给 Adapter，并返回 Adapter 产出的 encrypted response envelope。
- 内置或随包的本地工具应按产品隔离放置，例如 `adapters/<product>/`、`tools/<product>/` 或等价 manifest 声明；不得散落进 Bridge core 模块。
- Burn 需要的 `burn` backend/CLI、应用级本地 store、Codex/Claude profile scanner、Codex app-server launcher、Claude SDK runner、AI 历史扫描器、运行中会话监控、会话转录读取、账号级 AI 用量/成本账本、Desktop/Phone action 本机控制面等，可以随 Bridge Desktop 打包；代码归属放在本仓 manifest 隔离的 `panda-burn` Product Adapter / product local tools，逻辑不归 Bridge core。
- Codex CLI、Claude Code、用户账号和本机数据目录是用户电脑上的外部依赖/数据源；Bridge 可以让产品 Adapter 发现和调用，但不得把这些账号或业务数据变成云端或 core 状态。

## Managed Adapter 代码归属

- 用户电脑上需要安装、启动或长期运行的产品本机能力，代码默认归本仓的 managed adapter / product local tools；Burn 对应 `panda-burn` adapter，后续不再要求 sibling `syllo` 源码树作为运行时来源。
- `panda-burn` adapter 可以包含 Burn command handlers、Burn 本机 backend/CLI、应用级本地 store、Codex/Claude profile discovery、Codex app-server driver、Claude SDK runner、AI 历史读取、运行中会话监控、会话 transcript 分页读取、项目/会话派生索引、账号级 AI 用量/成本 ledger、Desktop/Phone action 本机控制面和本机权限策略。
- `panda-burn` adapter 是 Burn 在用户电脑上的唯一正式本机 runtime 归属；后续不得要求 sibling `syllo` 源码树提供 `backend/burn`、`scripts/bridge/*`、Claude/Codex runner、账号扫描器、历史扫描器、用量账本或本机 store。
- 旧 Task/Issue/project-level workspace 产品线不得通过迁移回流；adapter 只承接当前保留的应用级本地数据、账号/会话/项目派生索引、AI 用量、诊断和 Burn command surface。
- 上述业务代码只能位于 manifest 隔离的 adapter / product local tools 目录及其专属测试、打包脚本内；不得被 `apps/cloud-worker`、Desktop core、通用 SDK/protocol package 直接 import 或变成 core capability。
- Bridge core 只通过 `adapter.manifest.json` 发现、复制、启动、健康检查和路由 adapter，不按 `panda-burn`、Claude、Codex、账号、token 或项目业务做分支。
- 账号级 Claude Code / Codex 用量统计属于 `panda-burn` adapter：对外输出 account/day/month summary；session/request 级数据只能作为内部去重、补账和审计证据。
- Adapter artifact 必须自包含运行时依赖和本机工具，不依赖用户机器上的 sibling development repository；需要 Bridge SDK / Adapter SDK / protocol 时，把发布所需包打进 adapter artifact。

## Bridge / Burn 硬切分

- Bridge core 生产代码、Desktop core、通用 SDK/protocol 和通用桌面打包脚本不得再写 Burn 专名业务逻辑：禁止 Burn 产品归一化、Burn icon 分支、`BRIDGE_BURN_ADAPTER_DIR`、sibling 产品源码树默认路径、`burn_manifest` 或 `panda-burn` 专用 copy path 回流。Burn 专名只允许出现在 `panda-burn` adapter、产品 registry/授权展示、资源资产和对应测试里。
- Managed adapter 只能通过通用入口接入：打包时显式提供 `BRIDGE_MANAGED_ADAPTERS_DIR`，目录内每个 adapter 以 `adapter.manifest.json` 声明 `product_id`、runtime、entry 和 args；Bridge 只按 manifest 复制到 `Resources/adapters/<product_id>` 或等价资源目录。
- Bridge 不从产品仓库或 sibling source tree 推断 runtime。Burn 或其他产品若需要 Bridge SDK / Adapter SDK / protocol，必须把运行时包进自己的 adapter artifact；Bridge 打包脚本只消费 artifact，不复制产品源码依赖。
- 新增产品 adapter 时，只允许改通用 manifest 发现、runtime 启动、健康检查和 SDK 抽象；不得为了某个产品改 Bridge core 的 product alias、UI branding、业务 command 或路径默认值。
- 改动后至少运行 `node scripts/verify/relay-boundary.mjs` 和相关 desktop package check；涉及 managed adapter 启动时补跑 `cargo test --manifest-path apps/desktop/Cargo.toml managed_adapter_manifest_starts_node_runtime_and_returns_endpoint -- --nocapture`。

## 数据与明文

- 云端只保存必要路由元数据和短期密文 envelope 状态，不建设产品业务数据库。
- 业务明文只允许出现在 Product App 和用户电脑本机 Product Adapter / 产品本地数据目录里。
- Desktop core 的日志、diagnostics、status 只能暴露通用连接/Adapter 健康信息，不输出产品业务 payload、密钥、账号 token、本地文件正文或 AI 对话正文。
