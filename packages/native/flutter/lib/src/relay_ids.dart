import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

/// Byte/encoding/id helpers. Mirrors Kotlin `BridgeRelayIds`.
///
/// Standard base64 (with padding) for envelope fields; base64url (no padding)
/// only for JWK coordinates.
class BridgeRelayIds {
  BridgeRelayIds._();

  static final Random _random = Random.secure();

  /// Lowercase hex of a fresh 64-bit value. Mirrors Kotlin `Long.toHexString`
  /// (no leading zeros, no sign). Built from two 32-bit draws so it stays
  /// within Dart's safe-integer / web-int range.
  static String randomSuffix() {
    final hi = _random.nextInt(1 << 32);
    final lo = _random.nextInt(1 << 32);
    final value = (BigInt.from(hi) << 32) | BigInt.from(lo);
    return value.toRadixString(16);
  }

  /// 12 cryptographically-random bytes (GCM nonce).
  static Uint8List randomBytes(int length) {
    final bytes = Uint8List(length);
    for (var i = 0; i < length; i++) {
      bytes[i] = _random.nextInt(256);
    }
    return bytes;
  }

  /// Standard base64 with padding (Kotlin `Base64.NO_WRAP`).
  static String b64(List<int> bytes) => base64Encode(bytes);

  /// Standard base64 decode (with padding).
  static Uint8List b64Decode(String value) =>
      Uint8List.fromList(base64Decode(value));

  /// base64url, no padding (JWK alphabet).
  static String b64Url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

  /// base64url decode, tolerant of missing padding.
  static Uint8List b64UrlDecode(String value) {
    final normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    final padded = normalized.padRight((normalized.length + 3) & ~3, '=');
    return Uint8List.fromList(base64Decode(padded));
  }

  /// URL-encode a path/query component (matches Kotlin `URLEncoder`).
  static String urlEncode(String value) => Uri.encodeQueryComponent(value);

  /// Left-pad/trim a big-endian integer to exactly 32 bytes for an EC affine
  /// coordinate. Mirrors Kotlin `ecCoordinate`.
  static Uint8List ecCoordinate(Uint8List raw) {
    if (raw.length == 32) return raw;
    if (raw.length > 32) {
      return Uint8List.fromList(raw.sublist(raw.length - 32));
    }
    final out = Uint8List(32);
    out.setRange(32 - raw.length, 32, raw);
    return out;
  }
}
