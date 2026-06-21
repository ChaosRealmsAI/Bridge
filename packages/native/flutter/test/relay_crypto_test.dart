import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:bridge/bridge.dart';
import 'package:test/test.dart';

BridgeRelayContext _context(String relayKeyB64) => BridgeRelayContext(
      baseUrl: 'http://127.0.0.1:8799',
      productId: 'acme-chat',
      deviceId: 'dev_1',
      relayKeyB64: relayKeyB64,
      authorizationId: 'auth_1',
      authorizationEpoch: 3,
      relayKeyId: 'rkx_test',
    );

void main() {
  // Fixed 32-byte key so the test is deterministic on the key length assertion.
  final keyBytes = Uint8List.fromList(List<int>.generate(32, (i) => (i * 7 + 3) & 0xff));
  final keyB64 = base64Encode(keyBytes);

  test('encrypt -> decrypt round-trips JSON', () async {
    final context = _context(keyB64);
    final command = <String, dynamic>{
      'version': 'bridge-relay-v1',
      'type': 'acme.echo',
      'request_id': 'req_1',
      'input': {'message': 'hello world', 'count': 42, 'nested': {'a': true}},
    };
    final envelope = await BridgeRelayCrypto.encryptEnvelope(
      context,
      command,
      'chan_test',
      1,
      'req_1',
    );
    final decrypted = await BridgeRelayCrypto.decryptEnvelope(context, envelope);
    expect(decrypted, equals(command));
  });

  test('envelope ciphertext tail 16 bytes is the GCM tag', () async {
    final context = _context(keyB64);
    final command = <String, dynamic>{'hello': 'tag-check'};
    final envelope = await BridgeRelayCrypto.encryptEnvelope(
      context,
      command,
      'chan_test',
      1,
      'req_2',
    );

    final ciphertextBytes = base64Decode(envelope['ciphertext'] as String);
    final nonce = base64Decode(envelope['nonce'] as String);
    final aad = base64Decode(envelope['aad'] as String);
    expect(nonce.length, 12);

    // Re-run AES-GCM with the same inputs and confirm the recomputed tag equals
    // the last 16 bytes of the published ciphertext.
    final plaintext = utf8.encode(jsonEncode(command));
    final algo = AesGcm.with256bits();
    final box = await algo.encrypt(
      plaintext,
      secretKey: SecretKey(keyBytes),
      nonce: nonce,
      aad: aad,
    );
    final tail = ciphertextBytes.sublist(ciphertextBytes.length - 16);
    expect(tail, equals(box.mac.bytes));
    expect(ciphertextBytes.length - 16, equals(box.cipherText.length));
  });

  test('envelope carries the expected static fields', () async {
    final context = _context(keyB64);
    final envelope = await BridgeRelayCrypto.encryptEnvelope(
      context,
      <String, dynamic>{'x': 1},
      'chan_static',
      1,
      'req_3',
    );
    expect(envelope['algorithm'], 'AES-GCM-256');
    expect(envelope['direction'], 'product_to_device');
    expect(envelope['product_id'], 'acme-chat');
    expect(envelope['channel_id'], 'chan_static');
    expect(envelope['seq'], 1);
    final meta = envelope['meta'] as Map;
    expect(meta['authorization_id'], 'auth_1');
    expect(meta['relay_key_id'], 'rkx_test');
    // aad field equals base64(utf8(aadText))
    final aadText = BridgeRelayAad.relayEnvelopeAadText(
      productId: 'acme-chat',
      deviceId: 'dev_1',
      channelId: 'chan_static',
      seq: 1,
      authorizationId: 'auth_1',
      authorizationEpoch: 3,
      relayKeyId: 'rkx_test',
    );
    expect(envelope['aad'], base64Encode(utf8.encode(aadText)));
  });

  test('non-32-byte relay key is rejected', () async {
    final context = _context(base64Encode(List<int>.filled(16, 1)));
    expect(
      () => BridgeRelayCrypto.encryptEnvelope(
        context,
        <String, dynamic>{'x': 1},
        'c',
        1,
        'r',
      ),
      throwsA(isA<StateError>()),
    );
  });
}
