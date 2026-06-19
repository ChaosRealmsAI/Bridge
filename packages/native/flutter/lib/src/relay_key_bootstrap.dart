import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'p256.dart';
import 'relay_ids.dart';

/// ECDH-P256 relay-key wrapping for the bootstrap handshake. Mirrors Kotlin
/// `BridgeRelayKeyBootstrap`.
///
/// Wraps a 32-byte symmetric relay key so the desktop can unwrap it:
///  - ephemeral P-256 key pair, ECDH shared secret with the desktop public key,
///  - wrappingKey = SHA-256( sharedSecret ‖ "bridge-relay-key-bootstrap-v1" ‖ aad ),
///  - AES-256-GCM wrap of the relay key under that wrapping key,
///  - `app_public_jwk.x/y` = affine coordinates (32 bytes each), base64url no padding.
///
/// The P-256 ECDH (key gen, public point, shared X) uses the pure-Dart [P256]
/// so the wrap works in headless tests and on every native target without a
/// platform-crypto plugin. AES-GCM / SHA-256 still come from `cryptography`.
class BridgeRelayKeyBootstrap {
  BridgeRelayKeyBootstrap._();

  static const String _wrapVersion = 'bridge-relay-key-bootstrap-v1';

  /// [relayKey] must be exactly 32 bytes. [exchange] is the desktop-provided
  /// `relay_key_exchange` map (`public_jwk.{x,y}`, `key_id`). [aadText] is the
  /// bootstrap AAD string (see `BridgeRelayAad.relayKeyBootstrapAadText`).
  static Future<Map<String, dynamic>> wrapRelayKeyForDesktop(
    Uint8List relayKey,
    Map<String, dynamic> exchange,
    String aadText,
  ) async {
    if (relayKey.length != 32) {
      throw StateError('relay_key_must_be_32_bytes');
    }
    final publicJwk = exchange['public_jwk'];
    if (publicJwk is! Map) {
      throw const FormatException('invalid_relay_key_exchange');
    }
    final xBytes = BridgeRelayIds.b64UrlDecode((publicJwk['x'] ?? '') as String);
    final yBytes = BridgeRelayIds.b64UrlDecode((publicJwk['y'] ?? '') as String);
    final desktopX = P256.bytesToBigInt(BridgeRelayIds.ecCoordinate(xBytes));
    final desktopY = P256.bytesToBigInt(BridgeRelayIds.ecCoordinate(yBytes));

    // Ephemeral key pair + ECDH shared X (== WebCrypto deriveBits for P-256).
    final privateScalar = P256.newPrivateScalar();
    final (appX, appY) = P256.publicPoint(privateScalar);
    final sharedBytes = P256.sharedSecretX(privateScalar, desktopX, desktopY);

    final aad = Uint8List.fromList(utf8.encode(aadText));
    final wrappingKey = await _relayWrappingKey(sharedBytes, aad);

    final nonce = BridgeRelayIds.randomBytes(12);
    final algorithm = AesGcm.with256bits();
    final secretBox = await algorithm.encrypt(
      relayKey,
      secretKey: wrappingKey,
      nonce: nonce,
      aad: aad,
    );
    final ciphertext = Uint8List(secretBox.cipherText.length + secretBox.mac.bytes.length)
      ..setRange(0, secretBox.cipherText.length, secretBox.cipherText)
      ..setRange(secretBox.cipherText.length, secretBox.cipherText.length + secretBox.mac.bytes.length, secretBox.mac.bytes);

    final appPublicJwk = <String, dynamic>{
      'kty': 'EC',
      'crv': 'P-256',
      'x': BridgeRelayIds.b64Url(P256.bigIntTo32Bytes(appX)),
      'y': BridgeRelayIds.b64Url(P256.bigIntTo32Bytes(appY)),
    };

    return <String, dynamic>{
      'algorithm': 'ECDH-P256+A256GCM',
      'key_id': (exchange['key_id'] as String?) ?? '',
      'app_public_jwk': appPublicJwk,
      'nonce_b64': BridgeRelayIds.b64(nonce),
      'ciphertext_b64': BridgeRelayIds.b64(ciphertext),
      'aad_b64': BridgeRelayIds.b64(aad),
    };
  }

  static Future<SecretKey> _relayWrappingKey(
    List<int> sharedSecret,
    Uint8List aad,
  ) async {
    final material = <int>[
      ...sharedSecret,
      ...utf8.encode(_wrapVersion),
      ...aad,
    ];
    final digest = await Sha256().hash(material);
    return SecretKey(digest.bytes);
  }
}
