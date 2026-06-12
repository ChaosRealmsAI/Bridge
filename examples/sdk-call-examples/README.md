# SDK 调用示例

Panda Bridge SDK 的「调用面」示例：在本地进程内（内存 Worker）把 SDK 的各个 helper 都真实跑一遍，作为接入时的对照参考。

从仓库根目录运行：

```bash
npm run verify:sdk-examples
```

不需要启动外部服务：示例在进程内直接调用 Cloud Worker 的 fetch handler（内存存储），SDK 只看到一个普通的 `fetch`。

## 覆盖的 SDK 调用

- `diagnostics()`、`preflight()`、`queue.summary()`
- `auth.session()`、`auth.password()`、`auth.guest()`、`auth.share()`、`auth.join()`、`auth.logout()`
- `devices.list()`、`devices.createPairingCode()`、`devices.revoke()`
- `authorization.createIntent()`、`authorization.list()`、`authorization.authorize()`、`authorization.pause()`、`authorization.resume()`、`authorization.remove()`
- `connect.intent()`、`connect.claim()`
- `products.list()`
- `codex.chat()`、`codex.run()`、`codex.rpc()`
- `jobs.create()`、`jobs.get()`、`jobs.events()`、`jobs.wait()`、`jobs.stream()`、`jobs.cancel()`
- `ensureReady()`（账号级授权 + 自动连接流程）
- `createBridgeServerClient().state()`、`.createConnectIntent()`

## 谁做什么

产品侧只用 SDK。示例里模拟「桌面端 / 本机连接器」的部分只调用公开的 connector API（claim 意图、回传任务结果），不碰内部存储，也不需要真实的 Desktop / Codex 安装——生产环境里这部分由真实的 Panda Bridge Desktop 完成。

最小的「调用方究竟要写什么」请看 [`examples/minimal-caller/`](../minimal-caller/)；完整接入说明见 [`docs/product-integration.md`](../../docs/product-integration.md)。
