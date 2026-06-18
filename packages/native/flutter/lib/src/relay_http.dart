import 'dart:convert';
import 'dart:io';

import 'relay_context.dart';
import 'relay_error.dart';

/// Minimal JSON HTTP client over the relay. Mirrors Kotlin `BridgeRelayHttpClient`.
///
/// connectTimeout 8s, readTimeout 30s. Non-2xx -> `BridgeRelayError("http_<code>")`
/// with the body (first 180 chars) as detail. `pathMapper` lets callers rewrite
/// the `/v1/...` path for a web gateway.
class BridgeRelayHttpClient {
  BridgeRelayHttpClient(
    this.context, {
    String Function(String path)? pathMapper,
    HttpClient? httpClient,
  })  : _pathMapper = pathMapper ?? ((p) => p),
        _client = httpClient ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8));

  final BridgeRelayContext context;
  final String Function(String path) _pathMapper;
  final HttpClient _client;

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) =>
      _request('POST', path, body);

  Future<Map<String, dynamic>> get(String path) => _request('GET', path, null);

  Future<Map<String, dynamic>> _request(
    String method,
    String path,
    Map<String, dynamic>? body,
  ) async {
    final uri = Uri.parse(context.baseUrl + _pathMapper(path));
    final request = await _client.openUrl(method, uri);
    request.headers.set('accept', 'application/json');
    if (context.appOrigin.isNotEmpty) {
      request.headers.set('Origin', context.appOrigin);
    }
    if (context.authHeaderName.isNotEmpty && context.authHeaderValue.isNotEmpty) {
      request.headers.set(context.authHeaderName, context.authHeaderValue);
    }
    if (body != null) {
      request.headers.set('content-type', 'application/json; charset=utf-8');
      request.add(utf8.encode(jsonEncode(body)));
    }

    final response = await request.close().timeout(const Duration(seconds: 30));
    final text = await response.transform(utf8.decoder).join();
    final code = response.statusCode;
    if (code < 200 || code >= 300) {
      final snippet = text.length > 180 ? text.substring(0, 180) : text;
      throw BridgeRelayError('http_$code', 'http_$code: $snippet');
    }
    final decoded = text.isEmpty ? <String, dynamic>{} : jsonDecode(text);
    if (decoded is! Map) return <String, dynamic>{};
    return Map<String, dynamic>.from(decoded);
  }

  /// Release the underlying connection pool.
  void close() => _client.close(force: true);
}
