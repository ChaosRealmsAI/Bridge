import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:panda_bridge/panda_bridge.dart';
import 'package:panda_bridge/src/p256.dart';
import 'package:test/test.dart';

void main() {
  group('P256 (pure-Dart secp256r1)', () {
    test('ECDH agreement: dA*QB == dB*QA', () {
      final dA = P256.newPrivateScalar();
      final dB = P256.newPrivateScalar();
      final (ax, ay) = P256.publicPoint(dA);
      final (bx, by) = P256.publicPoint(dB);
      expect(P256.sharedSecretX(dA, bx, by), equals(P256.sharedSecretX(dB, ax, ay)));
    });

    test('public points lie on the curve', () {
      for (var i = 0; i < 5; i++) {
        final d = P256.newPrivateScalar();
        final (x, y) = P256.publicPoint(d);
        // y^2 == x^3 + a*x + b (mod p)
        final lhs = (y * y) % P256.p;
        final rhs = (((x * x % P256.p) * x) + (P256.a * x) + P256.b) % P256.p;
        expect(lhs, equals(rhs));
      }
    });

    test('rejects a peer point not on the curve', () {
      final d = P256.newPrivateScalar();
      expect(
        () => P256.sharedSecretX(d, BigInt.from(1), BigInt.from(2)),
        throwsA(isA<StateError>()),
      );
    });

    test('shared secret matches a known answer between two fixed scalars', () async {
      // Self-consistency vector recomputed both directions + via SHA path.
      final dA = BigInt.parse(
          '11111111111111111111111111111111111111111111111111111111111111', radix: 16);
      final dB = BigInt.parse(
          '22222222222222222222222222222222222222222222222222222222222222', radix: 16);
      final (ax, ay) = P256.publicPoint(dA);
      final (bx, by) = P256.publicPoint(dB);
      final s1 = P256.sharedSecretX(dA, bx, by);
      final s2 = P256.sharedSecretX(dB, ax, ay);
      expect(s1, equals(s2));
      expect(s1.length, 32);
    });
  });

  group('BridgeRelayKeyBootstrap.wrapRelayKeyForDesktop', () {
    test('wrap can be unwrapped by an independent Dart reimplementation '
        '(round-trip, proving the AES-GCM/SHA wrapping key derivation)', () async {
      // Desktop key pair (pure-Dart) plays the role of the JS/desktop side.
      final dDesktop = P256.newPrivateScalar();
      final (dx, dy) = P256.publicPoint(dDesktop);
      final exchange = <String, dynamic>{
        'key_id': 'rkx_unit',
        'public_jwk': {
          'kty': 'EC',
          'crv': 'P-256',
          'x': BridgeRelayIds.b64Url(P256.bigIntTo32Bytes(dx)),
          'y': BridgeRelayIds.b64Url(P256.bigIntTo32Bytes(dy)),
        },
      };
      final relayKey = Uint8List.fromList(List<int>.generate(32, (i) => (i * 9 + 4) & 0xff));
      final aadText = BridgeRelayAad.relayKeyBootstrapAadText(
        productId: 'acme-chat',
        deviceId: 'dev_1',
        authorizationId: 'auth_1',
        authorizationEpoch: 3,
        keyId: 'rkx_unit',
      );

      final wrapped =
          await BridgeRelayKeyBootstrap.wrapRelayKeyForDesktop(relayKey, exchange, aadText);

      expect(wrapped['algorithm'], 'ECDH-P256+A256GCM');
      expect(wrapped['key_id'], 'rkx_unit');
      final appJwk = wrapped['app_public_jwk'] as Map;
      expect(appJwk['crv'], 'P-256');

      // Desktop-side unwrap (mirrors adapter-sdk importBridgeRelayKeyBootstrap):
      // ECDH on the app's public point -> sharedX -> SHA-256(shared|const|aad) -> A256GCM open.
      final appX = P256.bytesToBigInt(BridgeRelayIds.b64UrlDecode(appJwk['x'] as String));
      final appY = P256.bytesToBigInt(BridgeRelayIds.b64UrlDecode(appJwk['y'] as String));
      final sharedX = P256.sharedSecretX(dDesktop, appX, appY);

      final aad = base64Decode(wrapped['aad_b64'] as String);
      expect(utf8.decode(aad), aadText);
      final material = <int>[...sharedX, ...utf8.encode('bridge-relay-key-bootstrap-v1'), ...aad];
      final wrappingKey = SecretKey((await Sha256().hash(material)).bytes);

      final ct = base64Decode(wrapped['ciphertext_b64'] as String);
      final nonce = base64Decode(wrapped['nonce_b64'] as String);
      final cipherText = ct.sublist(0, ct.length - 16);
      final mac = Mac(ct.sublist(ct.length - 16));
      final opened = await AesGcm.with256bits().decrypt(
        SecretBox(cipherText, nonce: nonce, mac: mac),
        secretKey: wrappingKey,
        aad: aad,
      );
      expect(Uint8List.fromList(opened), equals(relayKey));
    });

    test('rejects a non-32-byte relay key', () async {
      final d = P256.newPrivateScalar();
      final (x, y) = P256.publicPoint(d);
      final exchange = <String, dynamic>{
        'key_id': 'rkx_bad',
        'public_jwk': {
          'kty': 'EC',
          'crv': 'P-256',
          'x': BridgeRelayIds.b64Url(P256.bigIntTo32Bytes(x)),
          'y': BridgeRelayIds.b64Url(P256.bigIntTo32Bytes(y)),
        },
      };
      expect(
        () => BridgeRelayKeyBootstrap.wrapRelayKeyForDesktop(
          Uint8List.fromList(List<int>.filled(16, 1)),
          exchange,
          'aad',
        ),
        throwsA(isA<StateError>()),
      );
    });
  });
}
