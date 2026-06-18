// Live interop proof: this Dart SDK <-> the desktop relay adapter, byte-level.
//
// Assumes the local relay is already running, e.g.:
//   node /Users/Zhuanz/panda/syllo/scripts/verify/burn-local-app-relay.mjs \
//     --port 8799 --root /Users/Zhuanz/panda/syllo
//
// Usage:
//   dart run example/relay_smoke.dart [baseUrl]   (default http://127.0.0.1:8799)
//
// NOTE: the product-specific values (productId, channel prefix, sender/recipient
// ids, schema) below are *test data* pulled from the local dev session. The
// library itself stays product-neutral — everything is supplied via context.

import 'dart:convert';
import 'dart:io';

import 'package:panda_bridge/panda_bridge.dart';

Future<void> main(List<String> args) async {
  final baseUrl = args.isNotEmpty ? args.first : 'http://127.0.0.1:8799';

  // 1. Pull the dev session (already logged-in + connected + bootstrapped key).
  final session = await _getJson('$baseUrl/dev/session');
  stdout.writeln('[dev/session] ${jsonEncode({
        'productId': session['productId'],
        'deviceId': session['deviceId'],
        'relayKeyId': session['relayKeyId'],
        'authorizationId': session['authorizationId'],
        'channelPrefix': session['channelPrefix'],
      })}');

  final context = BridgeRelayContext(
    baseUrl: baseUrl,
    productId: session['productId'] as String,
    authHeaderName: 'cookie',
    authHeaderValue: (session['cookie'] as String?) ?? 'dev_session=local-app-relay',
    deviceId: session['deviceId'] as String,
    relayKeyB64: session['relayKeyB64'] as String,
    authorizationId: (session['authorizationId'] as String?) ?? '',
    authorizationEpoch: (session['authorizationEpoch'] as num?)?.toInt() ?? 1,
    relayKeyId: (session['relayKeyId'] as String?) ?? '',
    senderKeyId: (session['senderKeyId'] as String?) ?? 'bridge-product',
    recipientKeyId: (session['recipientKeyId'] as String?) ?? 'bridge-adapter',
    channelPrefix: (session['channelPrefix'] as String?) ?? 'bridge-client',
    schemaId: 'burn-relay-v1',
  );

  final client = BridgeRelayClient(context);

  // 2. health probe -> data.adapter_ready must be true.
  final health = await client.call(<String, dynamic>{
    'version': 'burn-relay-v1',
    'type': 'burn.relay.health',
    'request_id': 'smoke-health-${DateTime.now().millisecondsSinceEpoch}',
    'input': <String, dynamic>{},
  });
  final healthOk = health['ok'] == true;
  final healthData = (health['data'] as Map?) ?? const {};
  stdout.writeln('[health] ok=$healthOk data=${jsonEncode(healthData)}');
  _assert(healthOk, 'health result not ok');
  _assert(healthData['adapter_ready'] == true, 'adapter_ready != true');

  // 3. pwd probe -> data.cwd must contain the syllo root path.
  final pwd = await client.call(<String, dynamic>{
    'version': 'burn-relay-v1',
    'type': 'burn.probe.pwd',
    'request_id': 'smoke-pwd-${DateTime.now().millisecondsSinceEpoch}',
    'input': <String, dynamic>{},
  });
  final pwdOk = pwd['ok'] == true;
  final pwdData = (pwd['data'] as Map?) ?? const {};
  final cwd = (pwdData['cwd'] as String?) ?? '';
  stdout.writeln('[probe.pwd] ok=$pwdOk data=${jsonEncode(pwdData)}');
  _assert(pwdOk, 'pwd result not ok');
  _assert(cwd.contains('syllo'), 'cwd does not contain syllo: $cwd');

  client.http.close();
  stdout.writeln('INTEROP OK: Dart SDK <-> desktop relay adapter byte-compatible.');
}

Future<Map<String, dynamic>> _getJson(String url) async {
  final httpClient = HttpClient();
  try {
    final request = await httpClient.getUrl(Uri.parse(url));
    request.headers.set('accept', 'application/json');
    final response = await request.close();
    final text = await response.transform(utf8.decoder).join();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('GET $url -> ${response.statusCode}: $text');
    }
    return Map<String, dynamic>.from(jsonDecode(text) as Map);
  } finally {
    httpClient.close(force: true);
  }
}

void _assert(bool condition, String message) {
  if (!condition) {
    stderr.writeln('ASSERTION FAILED: $message');
    exit(1);
  }
}
