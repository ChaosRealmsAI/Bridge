import 'relay_context.dart';
import 'relay_crypto.dart';
import 'relay_error.dart';
import 'relay_http.dart';
import 'relay_ids.dart';

/// High-level relay client. Mirrors Kotlin `BridgeRelayClient`.
///
/// `call()` encrypts the command into a `product_to_device` envelope, POSTs it,
/// then long-polls for the matching `device_to_product` response(s), ACKing and
/// decrypting each, surfacing progress via [onProgress] and returning the final
/// result.
class BridgeRelayClient {
  BridgeRelayClient(this.context, {BridgeRelayHttpClient? http})
      : http = http ?? BridgeRelayHttpClient(context);

  final BridgeRelayContext context;
  final BridgeRelayHttpClient http;

  /// Default progress predicate: `result["progress"] == true`.
  static bool defaultIsProgress(Map<String, dynamic> result) =>
      result['progress'] == true;

  /// Send [command] and await the final decrypted result.
  ///
  /// [onProgress] (when non-null) is invoked for each progress envelope with
  /// `result["data"] ?? result`; polling uses limit=10. Without it, limit=1.
  ///
  /// Latency note: the GET carries `wait_ms` so the relay long-polls (production
  /// holds the request until an envelope lands; ~50-250ms for a fast command).
  /// Between GETs we start with a short delay ([fastPollMs]) and back off toward
  /// [slowPollMs], so a ~50ms backend command is no longer pinned to a fixed
  /// 700ms client sleep. Mock relays that ignore `wait_ms` still get a tight
  /// re-poll instead of the old 700ms wait.
  static const int fastPollMs = 60;
  static const int slowPollMs = 700;
  static const int fastPollProgressMs = 60;
  static const int slowPollProgressMs = 350;

  Future<Map<String, dynamic>> call(
    Map<String, dynamic> command, {
    int timeoutMs = 270000,
    Future<void> Function(Map<String, dynamic> data)? onProgress,
    bool Function(Map<String, dynamic> result)? isProgress,
  }) async {
    if (!context.ready) {
      throw BridgeRelayError('bridge_not_ready');
    }
    final progressCheck = isProgress ?? defaultIsProgress;

    final now = DateTime.now().millisecondsSinceEpoch;
    final channelId = '${context.channelPrefix}-$now-${BridgeRelayIds.randomSuffix()}';
    final existingRequestId = (command['request_id'] as String?)?.trim() ?? '';
    final requestKey = existingRequestId.isEmpty
        ? 'bridge-$now-${BridgeRelayIds.randomSuffix()}'
        : existingRequestId;
    final requestCommand = <String, dynamic>{...command, 'request_id': requestKey};

    final envelope = await BridgeRelayCrypto.encryptEnvelope(
      context,
      requestCommand,
      channelId,
      1,
      requestKey,
    );
    final pid = BridgeRelayIds.urlEncode(context.productId);
    await http.post('/v1/products/$pid/relay/envelopes', envelope);

    var afterSeq = 1;
    final deadline = DateTime.now().millisecondsSinceEpoch + timeoutMs;
    // Ramp the inter-poll delay from fast -> slow. Production relays long-poll
    // (wait_ms) and return the instant an envelope lands; this delay only covers
    // mock relays that return immediately, so start tight and back off.
    final fast = onProgress == null ? fastPollMs : fastPollProgressMs;
    final slow = onProgress == null ? slowPollMs : slowPollProgressMs;
    var pollDelayMs = fast;
    var firstPoll = true;
    while (DateTime.now().millisecondsSinceEpoch < deadline) {
      final limit = onProgress == null ? 1 : 10;
      final pollPath = '/v1/products/$pid/relay/envelopes'
          '?device_id=${BridgeRelayIds.urlEncode(context.deviceId)}'
          '&channel_id=${BridgeRelayIds.urlEncode(channelId)}'
          '&after_seq=$afterSeq&limit=$limit&wait_ms=1000';
      final payload = await http.get(pollPath);
      final rawItems = payload['items'];
      final items = rawItems is List ? rawItems : const [];

      for (final raw in items) {
        if (raw is! Map) continue;
        final responseEnvelope = Map<String, dynamic>.from(raw);
        final direction = (responseEnvelope['direction'] as String?) ?? '';
        if (direction.isNotEmpty && direction != 'device_to_product') {
          throw BridgeRelayError('unexpected_response_direction', direction);
        }
        final result = await BridgeRelayCrypto.decryptEnvelope(context, responseEnvelope);
        final responseId = (responseEnvelope['id'] as String?) ?? '';
        final seq = _asInt(responseEnvelope['seq']) ?? afterSeq;
        if (seq > afterSeq) afterSeq = seq;

        if (responseId.isNotEmpty) {
          await http.post(
            '/v1/products/$pid/relay/envelopes/${BridgeRelayIds.urlEncode(responseId)}/ack',
            <String, dynamic>{'status': 'acked', 'device_id': context.deviceId},
          );
        }

        if (result['ok'] == false) {
          final code = _nonEmpty(result['error']) ?? 'bridge_adapter_error';
          final message = _nonEmpty(result['message']) ?? code;
          final causeCode = _nonEmpty(result['cause_code']) ?? _nonEmpty(result['code']) ?? '';
          throw BridgeRelayError(code, message, causeCode);
        }

        if (onProgress != null && progressCheck(result)) {
          final data = result['data'];
          await onProgress(data is Map ? Map<String, dynamic>.from(data) : result);
          // Streaming reply is active: keep polling tight so chunks render live.
          pollDelayMs = fast;
          firstPoll = false;
          continue;
        }
        return result;
      }

      // No envelope this round. The first empty poll often just means the mock
      // relay hasn't run the adapter yet, so retry quickly, then back off.
      if (firstPoll) {
        firstPoll = false;
      } else {
        pollDelayMs = (pollDelayMs * 2).clamp(fast, slow);
      }
      await Future<void>.delayed(Duration(milliseconds: pollDelayMs));
    }
    throw BridgeRelayError('bridge_relay_timeout', 'Bridge relay timed out.');
  }

  static int? _asInt(Object? value) {
    if (value is int) return value;
    if (value is double) return value.toInt();
    if (value is String) return int.tryParse(value);
    return null;
  }

  static String? _nonEmpty(Object? value) {
    if (value is String && value.isNotEmpty) return value;
    return null;
  }
}
