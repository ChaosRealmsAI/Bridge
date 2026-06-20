# SDK 调用示例

这个示例只覆盖当前 Bridge SDK 调用面：账号/授权/状态、relay envelope、`waitForResponse()`、`createCall()`，以及服务端 delegated connect + relay round trip。

从仓库根目录运行：

```bash
npm run verify:sdk-examples
```

不需要启动外部服务：浏览器 SDK surface 使用 fake fetch 验证请求形状，服务端最小调用方复用 `examples/minimal-caller/run-local.mjs`，在进程内直接调用 Cloud Worker fetch handler。

## 覆盖的 SDK 调用

- `createBridgeClient().diagnostics()`
- `createBridgeClient().products.list()`
- `createBridgeClient().connect.createIntent()`
- `createBridgeClient().relay.create()`
- `createBridgeClient().relay.waitForResponse()`
- `createBridgeClient().relay.createCall()`
- `createBridgeServerClient().state()`
- `createBridgeServerClient().createConnectIntent()`
- `createBridgeServerClient().bootstrapRelayKey()`
- `createBridgeServerClient().createRelayEnvelope()`
- `createBridgeServerClient().waitForResponse()`

Bridge SDK 不提供产品业务 helper。产品 command schema、加密 session、明文处理和本机执行都在调用方产品和 Product Adapter 内完成。

更小的接入路线看 [`examples/minimal-caller/`](../minimal-caller/)；完整接入说明见 [`spec/L4/reference-materials/docs/product-integration.md`](../../spec/L4/reference-materials/docs/product-integration.md)。
