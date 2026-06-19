// CLI bridge for the byte-level interop test (test/relay_key_bootstrap_interop.test.mjs).
//
// Reads a single JSON request on stdin and prints the wrapped bootstrap envelope
// (the `wrapped_key` map produced by BridgeRelayKeyBootstrap.wrapRelayKeyForDesktop)
// on stdout, so the JS adapter-sdk can unwrap it and prove byte compatibility.
//
// Request shape (stdin):
//   {
//     "product_id": "...", "device_id": "...",
//     "authorization_id": "...", "authorization_epoch": 3,
//     "relay_key_b64": "<standard base64 of a known 32-byte key>",
//     "exchange": { "key_id": "rkx_...", "public_jwk": { "kty","crv","x","y" } }
//   }
//
// Response shape (stdout): the wrapped_key map plus the aad text used, e.g.
//   { "algorithm","key_id","app_public_jwk","nonce_b64","ciphertext_b64","aad_b64","aad_text" }
//
// Run: dart run tool/wrap_relay_key.dart   (request piped on stdin)
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:panda_bridge/panda_bridge.dart';

Future<void> main() async {
  final raw = await stdin.transform(utf8.decoder).join();
  final req = jsonDecode(raw) as Map<String, dynamic>;

  final relayKey = Uint8List.fromList(base64Decode(req['relay_key_b64'] as String));
  final exchange = Map<String, dynamic>.from(req['exchange'] as Map);

  final aadText = BridgeRelayAad.relayKeyBootstrapAadText(
    productId: req['product_id'] as String,
    deviceId: req['device_id'] as String,
    authorizationId: req['authorization_id'] as String,
    authorizationEpoch: req['authorization_epoch'] ?? 1,
    keyId: exchange['key_id'] as String,
  );

  final wrapped =
      await BridgeRelayKeyBootstrap.wrapRelayKeyForDesktop(relayKey, exchange, aadText);
  wrapped['aad_text'] = aadText;

  stdout.write(jsonEncode(wrapped));
}
