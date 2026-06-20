/// Connection + identity configuration for a relay session. Mirrors Kotlin
/// `BridgeRelayContext`.
///
/// Product-neutral: every product-specific value (productId, channelPrefix,
/// sender/recipient key ids, schema, adapter id) is supplied by the caller.
/// Defaults are the generic `bridge-*` values from the Kotlin SDK.
class BridgeRelayContext {
  BridgeRelayContext({
    required this.baseUrl,
    required this.productId,
    this.authHeaderName = '',
    this.authHeaderValue = '',
    this.appOrigin = '',
    required this.deviceId,
    required this.relayKeyB64,
    this.authorizationId = '',
    this.authorizationEpoch = 1,
    this.relayKeyId = '',
    this.senderKeyId = 'bridge-product',
    this.recipientKeyId = 'bridge-adapter',
    this.channelPrefix = 'bridge-client',
    String? adapterId,
    this.schemaId = 'bridge-relay-v1',
    this.requestGzipThresholdBytes = 16 * 1024,
  }) : adapterId = adapterId ?? productId;

  /// Base URL of the relay (Bridge / local). No trailing slash expected.
  final String baseUrl;

  /// Product identifier (path segment + envelope field). Caller-supplied.
  final String productId;

  /// Auth header name (e.g. `authorization` or `cookie`). Empty = no header.
  final String authHeaderName;

  /// Auth header value (e.g. `Bearer <token>` or `<cookie>`).
  final String authHeaderValue;

  /// `Origin` header value, when the relay enforces an origin allowlist.
  final String appOrigin;

  /// Device identifier (path/query + envelope field).
  final String deviceId;

  /// Standard base64 of the 32-byte symmetric relay key.
  final String relayKeyB64;

  /// Authorization id (envelope/meta + AAD). Empty when not bootstrapped.
  final String authorizationId;

  /// Authorization epoch.
  final int authorizationEpoch;

  /// Relay key id (envelope/meta + AAD).
  final String relayKeyId;

  /// Sender key id (envelope field, not a key).
  final String senderKeyId;

  /// Recipient key id (envelope field, not a key).
  final String recipientKeyId;

  /// Channel id prefix. Each call appends `-<millis>-<hexRand>`.
  final String channelPrefix;

  /// Adapter id (meta field). Defaults to [productId].
  final String adapterId;

  /// Schema id (meta field).
  final String schemaId;

  /// Plaintext size above which the request payload is gzip-compressed.
  final int requestGzipThresholdBytes;

  /// True when enough fields are present to attempt a relay round trip.
  bool get ready =>
      baseUrl.isNotEmpty &&
      productId.isNotEmpty &&
      deviceId.isNotEmpty &&
      relayKeyB64.isNotEmpty;
}
