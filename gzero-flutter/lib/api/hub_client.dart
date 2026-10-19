// hub_client.dart — the Transport plane's hub half (research/flutter-client.md).
//
// Speaks the gzero-hub v0 wire: bearer-token auth, per-stream change
// endpoints. v0 reads only — health and per-stream head seq for the sync
// status card; doc decoding (automerge) is a later plane decision.

import 'dart:convert';

import 'package:http/http.dart' as http;

/// The deployed hub v0; the default in settings until the user overrides it.
const String defaultHubUrl = 'https://gzero-hub.nick-hems.workers.dev';

class HubException implements Exception {
  HubException(this.status, this.detail);
  final int status;
  final String detail;

  @override
  String toString() => 'hub $status: $detail';
}

class HubClient {
  HubClient({required this.baseUrl, this.token = '', http.Client? httpClient})
    : _http = httpClient ?? http.Client();

  final String baseUrl;
  final String token;
  final http.Client _http;

  Map<String, String> get _headers => {
    if (token.isNotEmpty) 'authorization': 'Bearer $token',
  };

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse(baseUrl.replaceAll(RegExp(r'/+$'), '') + path).replace(queryParameters: query);

  /// GET /health — the liveness check (no auth required).
  Future<void> health() async {
    final res = await _http.get(_uri('/health'), headers: _headers);
    if (res.statusCode != 200) {
      throw HubException(res.statusCode, 'health failed');
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (body['status'] != 'ok') {
      throw HubException(res.statusCode, 'unexpected health body: $body');
    }
  }

  /// The stream's highest change seq — the observable of "how much is
  /// there" and the base of the future pull cursor.
  Future<int> headSeq(String stream) async {
    final res = await _http.get(
      _uri('/stream/$stream/changes', {'since': '0', 'limit': '1'}),
      headers: _headers,
    );
    if (res.statusCode != 200) {
      throw HubException(res.statusCode, 'headSeq($stream) failed');
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final seq = body['last_seq'];
    if (seq is! int) {
      throw HubException(res.statusCode, 'headSeq($stream): missing last_seq');
    }
    return seq;
  }
}
