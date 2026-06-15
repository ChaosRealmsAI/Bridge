# Bridge Desktop · macOS 签名 / 公证 / 发布

## 为什么必须做

Bridge Desktop 是要发给用户的 macOS App。**未签名 / ad-hoc(`codesign --sign -`)的构建**:

- 会被 **Gatekeeper 拦截**("来自身份不明的开发者" / "已损坏"),用户很难打开;
- 会被 **App Translocation** 从随机只读路径运行,每次路径都变;
- 签名不稳定 → macOS 钥匙串的"始终允许"钉不住 → **每次启动都弹登录密码**。

**唯一的生产解 = 用 Developer ID Application 证书签名(开 hardened runtime + entitlements + 安全时间戳)+ Apple 公证(notarization)+ staple。** 做完后:Gatekeeper 放行、不再 translocation、签名稳定 → 钥匙串"始终允许"生效 → **不再每次要密码**(App 读自己写的钥匙串项,稳定签名下零弹窗)。

## 一次性准备(需要 Apple Developer 账号,$99/年)

1. 在「钥匙串访问」里装好 **Developer ID Application** 证书(从 Apple Developer 后台申请),例如身份名:
   `Developer ID Application: Your Name (TEAMID)`
2. 建一个公证凭据 profile(用 App 专用密码,一次即可):
   ```bash
   xcrun notarytool store-credentials panda-bridge-notary \
     --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
   ```

## 出发布包(签名 + 公证 + staple,一条命令)

```bash
export PANDA_BRIDGE_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export PANDA_BRIDGE_NOTARY_PROFILE="panda-bridge-notary"
npm run desktop:package:mac
```
产物在 `dist/desktop/macos/panda-bridge-macos.dmg`,输出 JSON 里 `distributable: true` 表示已签名+公证+staple,可直接发用户。

- 不设这两个 env → 脚本仍能跑,但只做 **ad-hoc(dev)签名、不公证**,输出会 `distributable: false` 并打印警告。**这种包只能本机自测,别发用户。**
- entitlements 自动写在 `dist/desktop/macos/panda-bridge.entitlements.plist`(WKWebView 需要的 JIT / unsigned-exec-memory;非沙盒 App 网络与登录钥匙串无需额外 entitlement)。

## 本机开发(不弹密码)

- **debug 构建默认不用钥匙串**(走文件存储),所以 `npm run desktop:dev` / `cargo run` 本机调试**不会弹登录密码**。
- 想在 debug 下也用钥匙串:`PANDA_BRIDGE_USE_KEYCHAIN=1`。
- 想在任何构建下强制不用钥匙串:`PANDA_BRIDGE_SKIP_KEYCHAIN=1`。
- release 构建默认用钥匙串(配合上面的签名 → 不弹)。

## 校验

```bash
codesign --verify --strict --verbose=2 "dist/desktop/macos/Panda Bridge.app"
spctl -a -vv "dist/desktop/macos/Panda Bridge.app"     # 应显示 accepted / Notarized Developer ID
xcrun stapler validate "dist/desktop/macos/panda-bridge-macos.dmg"
```
