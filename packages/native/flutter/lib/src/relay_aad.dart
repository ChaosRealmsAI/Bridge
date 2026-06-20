/// Additional-authenticated-data (AAD) text builders. Mirrors Kotlin
/// `BridgeRelayAad`. Byte-exact: any deviation makes GCM tag verification fail
/// on the desktop side.
class BridgeRelayAad {
  BridgeRelayAad._();

  /// Envelope AAD: 5 base segments joined by `|`, with no trailing separator.
  ///
  /// When both [authorizationId] and [relayKeyId] are non-empty, three more
  /// segments (`authorization` / `epoch` / `relay_key`) are appended.
  ///
  /// ```
  /// product:<pid>|device:<did>|channel:<cid>|direction:<dir>|seq:<n>
  ///   [|authorization:<aid>|epoch:<epoch>|relay_key:<rkid>]
  /// ```
  static String relayEnvelopeAadText({
    required String productId,
    required String deviceId,
    required String channelId,
    String direction = 'product_to_device',
    required int seq,
    String authorizationId = '',
    Object authorizationEpoch = 1,
    String relayKeyId = '',
  }) {
    final dir = direction.trim().isEmpty ? 'product_to_device' : direction.trim();
    final parts = <String>[
      'product:${productId.trim()}',
      'device:${deviceId.trim()}',
      'channel:${channelId.trim()}',
      'direction:$dir',
      'seq:$seq',
    ];
    final aid = authorizationId.trim();
    final rkid = relayKeyId.trim();
    if (aid.isNotEmpty && rkid.isNotEmpty) {
      final epoch = _epochString(authorizationEpoch);
      parts.add('authorization:$aid');
      parts.add('epoch:$epoch');
      parts.add('relay_key:$rkid');
    }
    return parts.join('|');
  }

  /// Relay-key-bootstrap AAD. Mirrors Kotlin `relayKeyBootstrapAadText`:
  /// `bridge-relay-key-bootstrap-v1|<pid>|<did>|<aid>|<epoch>|<keyId>`.
  static String relayKeyBootstrapAadText({
    required String productId,
    required String deviceId,
    required String authorizationId,
    Object authorizationEpoch = 1,
    required String keyId,
  }) {
    return [
      'bridge-relay-key-bootstrap-v1',
      productId,
      deviceId,
      authorizationId,
      _epochString(authorizationEpoch),
      keyId,
    ].join('|');
  }

  static String _epochString(Object epoch) {
    if (epoch is int) return epoch.toString();
    if (epoch is BigInt) return epoch.toString();
    final text = epoch.toString().trim();
    return text.isEmpty ? '1' : text;
  }
}
