import 'dart:math';
import 'dart:typed_data';

/// Minimal pure-Dart NIST P-256 (secp256r1) for the relay-key bootstrap ECDH.
///
/// Why this exists: the `cryptography` package delegates ECDH-P256 to a platform
/// backend (browser WebCrypto / Flutter plugin); its pure-Dart fallback throws
/// `UnimplementedError`. That makes the relay-key wrap unusable both in headless
/// `dart test` / `flutter test` (no platform crypto) and on plain native targets
/// unless an extra plugin is wired in. The bootstrap handshake must be byte-for-
/// byte interop-tested in CI, so the EC math lives here, in pure Dart — no
/// platform dependency. AES-256-GCM and SHA-256 still come from `cryptography`
/// (those have working pure-Dart backends).
///
/// Scope: just what the wrap needs — a random key pair, the public point's
/// affine X/Y, and the ECDH shared X coordinate. Constant-time-ness is NOT a
/// goal here (the wrapped key is ephemeral and the secret is immediately fed
/// through SHA-256); this mirrors the desktop WebCrypto math, not its hardening.
class P256 {
  P256._();

  // secp256r1 domain parameters (FIP 186-4 / SEC2).
  static final BigInt p = BigInt.parse(
      'FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF', radix: 16);
  static final BigInt a = BigInt.parse(
      'FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFC', radix: 16);
  static final BigInt b = BigInt.parse(
      '5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B', radix: 16);
  static final BigInt n = BigInt.parse(
      'FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551', radix: 16);
  static final BigInt gx = BigInt.parse(
      '6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296', radix: 16);
  static final BigInt gy = BigInt.parse(
      '4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5', radix: 16);

  static final Random _random = Random.secure();

  /// A fresh private scalar `d` in `[1, n-1]`.
  static BigInt newPrivateScalar() {
    while (true) {
      final d = _randomScalar();
      if (d != BigInt.zero && d < n) return d;
    }
  }

  /// Public point `d*G` as affine (X, Y), each a non-negative BigInt < p.
  static (BigInt, BigInt) publicPoint(BigInt d) {
    final point = _scalarMul(d, _ECPoint(gx, gy));
    if (point.isInfinity) {
      throw StateError('p256_public_point_infinity');
    }
    return (point.x!, point.y!);
  }

  /// ECDH shared secret: the X coordinate of `d * Q`, as a fixed 32-byte
  /// big-endian array (WebCrypto `deriveBits` returns exactly this for P-256).
  static Uint8List sharedSecretX(BigInt d, BigInt qx, BigInt qy) {
    final q = _ECPoint(qx, qy);
    if (!_isOnCurve(q)) {
      throw StateError('p256_peer_point_not_on_curve');
    }
    final shared = _scalarMul(d, q);
    if (shared.isInfinity) {
      throw StateError('p256_shared_point_infinity');
    }
    return bigIntTo32Bytes(shared.x!);
  }

  /// Big-endian, fixed 32-byte encoding (left zero-padded / high-byte trimmed).
  static Uint8List bigIntTo32Bytes(BigInt value) {
    final out = Uint8List(32);
    var v = value;
    final mask = BigInt.from(0xff);
    for (var i = 31; i >= 0; i--) {
      out[i] = (v & mask).toInt();
      v = v >> 8;
    }
    return out;
  }

  /// Big-endian bytes -> non-negative BigInt.
  static BigInt bytesToBigInt(List<int> bytes) {
    var result = BigInt.zero;
    for (final byte in bytes) {
      result = (result << 8) | BigInt.from(byte & 0xff);
    }
    return result;
  }

  // MARK: - curve arithmetic (Jacobian-free affine; fine for one mul per wrap)

  static BigInt _randomScalar() {
    final bytes = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      bytes[i] = _random.nextInt(256);
    }
    return bytesToBigInt(bytes) % n;
  }

  static bool _isOnCurve(_ECPoint q) {
    if (q.isInfinity) return false;
    final x = q.x!;
    final y = q.y!;
    if (x < BigInt.zero || x >= p || y < BigInt.zero || y >= p) return false;
    final lhs = (y * y) % p;
    final rhs = (((x * x % p) * x) + (a * x) + b) % p;
    return lhs == rhs;
  }

  static _ECPoint _scalarMul(BigInt k, _ECPoint point) {
    var result = const _ECPoint.infinity();
    var addend = point;
    var scalar = k % n;
    while (scalar > BigInt.zero) {
      if ((scalar & BigInt.one) == BigInt.one) {
        result = _add(result, addend);
      }
      addend = _double(addend);
      scalar = scalar >> 1;
    }
    return result;
  }

  static _ECPoint _add(_ECPoint p1, _ECPoint p2) {
    if (p1.isInfinity) return p2;
    if (p2.isInfinity) return p1;
    final x1 = p1.x!;
    final y1 = p1.y!;
    final x2 = p2.x!;
    final y2 = p2.y!;
    if (x1 == x2) {
      if ((y1 + y2) % p == BigInt.zero) return const _ECPoint.infinity();
      return _double(p1);
    }
    final slope = ((y2 - y1) * _inverseMod(x2 - x1, p)) % p;
    final x3 = (slope * slope - x1 - x2) % p;
    final y3 = (slope * (x1 - x3) - y1) % p;
    return _ECPoint(x3 % p, y3 % p);
  }

  static _ECPoint _double(_ECPoint point) {
    if (point.isInfinity) return point;
    final x = point.x!;
    final y = point.y!;
    if (y == BigInt.zero) return const _ECPoint.infinity();
    final slope =
        ((BigInt.from(3) * x * x + a) * _inverseMod(BigInt.two * y, p)) % p;
    final x3 = (slope * slope - BigInt.two * x) % p;
    final y3 = (slope * (x - x3) - y) % p;
    return _ECPoint(x3 % p, y3 % p);
  }

  /// Modular inverse via the extended Euclidean algorithm.
  static BigInt _inverseMod(BigInt value, BigInt modulus) {
    var v = value % modulus;
    if (v < BigInt.zero) v += modulus;
    var lm = BigInt.one;
    var hm = BigInt.zero;
    var low = v;
    var high = modulus;
    while (low > BigInt.one) {
      final ratio = high ~/ low;
      final nm = hm - lm * ratio;
      final newLow = high - low * ratio;
      hm = lm;
      high = low;
      lm = nm;
      low = newLow;
    }
    return lm % modulus;
  }
}

/// Affine EC point; `_ECPoint.infinity()` is the point at infinity (identity).
class _ECPoint {
  const _ECPoint(this.x, this.y);
  const _ECPoint.infinity()
      : x = null,
        y = null;

  final BigInt? x;
  final BigInt? y;

  bool get isInfinity => x == null;
}
