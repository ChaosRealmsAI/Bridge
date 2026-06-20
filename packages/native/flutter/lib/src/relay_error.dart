/// Error raised by the relay SDK. Mirrors Kotlin `BridgeRelayError`.
///
/// [code] is the machine-readable code, [detail] is the human message (falls
/// back to [code] when blank), and [causeCode] is an optional upstream code.
class BridgeRelayError implements Exception {
  BridgeRelayError(this.code, [String detail = '', this.causeCode = ''])
      : detail = detail.isEmpty ? code : detail;

  final String code;
  final String detail;
  final String causeCode;

  @override
  String toString() => 'BridgeRelayError($code): $detail'
      '${causeCode.isEmpty ? '' : ' [cause: $causeCode]'}';
}
