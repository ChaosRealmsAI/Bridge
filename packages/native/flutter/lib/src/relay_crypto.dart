import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'relay_aad.dart';
import 'relay_context.dart';
import 'relay_ids.dart';

/// AES-256-GCM envelope encrypt/decrypt. Mirrors Kotlin `BridgeRelayCrypto`.
///
/// Byte-exact rules:
///  - nonce = 12 random bytes, tag = 128-bit.
///  - `envelope.ciphertext = base64(cipherText ‖ mac.bytes)` — `package:cryptography`
///    keeps cipherText and mac separate, so they are concatenated on encrypt and
///    split (last 16 bytes = mac) on decrypt.
///  - standard base64 (with padding) for `ciphertext` / `nonce` / `aad`.
///  - gzip the plaintext only when it exceeds the context threshold.
class BridgeRelayCrypto {
  BridgeRelayCrypto._();

  static final AesGcm _algorithm = AesGcm.with256bits();
  static const int _macLength = 16;

  /// Build the request envelope JSON for [command].
  static Future<Map<String, dynamic>> encryptEnvelope(
    BridgeRelayContext context,
    Map<String, dynamic> command,
    String channelId,
    int seq,
    String requestKey,
  ) async {
    final aadText = BridgeRelayAad.relayEnvelopeAadText(
      productId: context.productId,
      deviceId: context.deviceId,
      channelId: channelId,
      direction: 'product_to_device',
      seq: seq,
      authorizationId: context.authorizationId,
      authorizationEpoch: context.authorizationEpoch,
      relayKeyId: context.relayKeyId,
    );
    final aadBytes = Uint8List.fromList(utf8.encode(aadText));
    final nonce = BridgeRelayIds.randomBytes(12);
    final encoded = _encodeJsonPayload(command, context.requestGzipThresholdBytes);

    final secretBox = await _algorithm.encrypt(
      encoded.bytes,
      secretKey: await _relayKey(context),
      nonce: nonce,
      aad: aadBytes,
    );
    // cipherText followed by the 16-byte tag, matching WebCrypto/JCA layout.
    final ciphertext = Uint8List(secretBox.cipherText.length + secretBox.mac.bytes.length)
      ..setRange(0, secretBox.cipherText.length, secretBox.cipherText)
      ..setRange(secretBox.cipherText.length, secretBox.cipherText.length + secretBox.mac.bytes.length, secretBox.mac.bytes);

    final meta = <String, dynamic>{
      'adapter_id': context.adapterId,
      'trace_id': requestKey,
      'schema_id': context.schemaId,
      'content_type': 'application/json',
    };
    if (context.authorizationId.trim().isNotEmpty &&
        context.relayKeyId.trim().isNotEmpty) {
      meta['authorization_id'] = context.authorizationId;
      meta['authorization_epoch'] = context.authorizationEpoch;
      meta['relay_key_id'] = context.relayKeyId;
    }
    if (encoded.contentEncoding.isNotEmpty) {
      meta['content_encoding'] = encoded.contentEncoding;
    }

    return <String, dynamic>{
      'product_id': context.productId,
      'device_id': context.deviceId,
      'channel_id': channelId,
      'direction': 'product_to_device',
      'seq': seq,
      'request_key': requestKey,
      'ciphertext': BridgeRelayIds.b64(ciphertext),
      'aad': BridgeRelayIds.b64(aadBytes),
      'nonce': BridgeRelayIds.b64(nonce),
      'algorithm': 'AES-GCM-256',
      'sender_key_id': context.senderKeyId,
      'recipient_key_id': context.recipientKeyId,
      'ttl_ms': 300000,
      'meta': meta,
    };
  }

  /// Decrypt a response envelope back into its JSON payload.
  static Future<Map<String, dynamic>> decryptEnvelope(
    BridgeRelayContext context,
    Map<String, dynamic> envelope,
  ) async {
    final nonce = BridgeRelayIds.b64Decode((envelope['nonce'] ?? '') as String);
    final aad = BridgeRelayIds.b64Decode((envelope['aad'] ?? '') as String);
    final all = BridgeRelayIds.b64Decode((envelope['ciphertext'] ?? '') as String);
    if (all.length < _macLength) {
      throw const FormatException('invalid_relay_envelope_ciphertext');
    }
    final cipherText = all.sublist(0, all.length - _macLength);
    final mac = Mac(all.sublist(all.length - _macLength));
    final box = SecretBox(cipherText, nonce: nonce, mac: mac);
    final opened = await _algorithm.decrypt(
      box,
      secretKey: await _relayKey(context),
      aad: aad,
    );

    final encoding = _contentEncoding(envelope);
    final jsonBytes = encoding == 'gzip'
        ? Uint8List.fromList(gzip.decode(opened))
        : opened;
    final decoded = jsonDecode(utf8.decode(jsonBytes));
    if (decoded is! Map) {
      throw const FormatException('relay_payload_not_object');
    }
    return Map<String, dynamic>.from(decoded);
  }

  static String _contentEncoding(Map<String, dynamic> envelope) {
    final meta = envelope['meta'];
    if (meta is Map) {
      final encoding = meta['content_encoding'];
      if (encoding is String) return encoding.toLowerCase();
    }
    return '';
  }

  static Future<SecretKey> _relayKey(BridgeRelayContext context) async {
    final bytes = BridgeRelayIds.b64Decode(context.relayKeyB64);
    if (bytes.length != 32) {
      throw StateError('relay_key_must_be_32_bytes');
    }
    return SecretKey(bytes);
  }

  static _EncodedPayload _encodeJsonPayload(
    Map<String, dynamic> command,
    int gzipThresholdBytes,
  ) {
    final raw = Uint8List.fromList(utf8.encode(jsonEncode(command)));
    if (raw.length <= gzipThresholdBytes) {
      return _EncodedPayload(raw, '');
    }
    return _EncodedPayload(Uint8List.fromList(gzip.encode(raw)), 'gzip');
  }
}

class _EncodedPayload {
  _EncodedPayload(this.bytes, this.contentEncoding);

  final Uint8List bytes;
  final String contentEncoding;
}
