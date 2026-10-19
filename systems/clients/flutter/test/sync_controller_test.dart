import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:gzero_client/api/hub_client.dart';
import 'package:gzero_client/state/sync_controller.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HubClient clientFor(
  http.Response? Function(Uri url) routes,
) {
  return HubClient(
    baseUrl: 'https://hub.test',
    token: 't',
    httpClient: MockClient((req) async => routes(req.url) ?? http.Response('404', 404)),
  );
}

void main() {
  test('refresh: healthy hub fills per-stream seqs', () async {
    final c = SyncController(
      clientFor((url) {
        if (url.path == '/health') return http.Response(jsonEncode({'status': 'ok'}), 200);
        return http.Response(jsonEncode({'last_seq': 123}), 200);
      }),
    );
    await c.refresh();
    expect(c.healthy, isTrue);
    expect(c.statuses.map((s) => s.name), ['context', 'comms']);
    expect(c.statuses.every((s) => s.lastSeq == 123), isTrue);
    expect(c.lastChecked, isNotNull);
  });

  test('refresh: unreachable hub surfaces connection error, per-stream not run', () async {
    final c = SyncController(
      HubClient(
        baseUrl: 'https://hub.test',
        httpClient: MockClient((_) async => http.Response('down', 503)),
      ),
    );
    await c.refresh();
    expect(c.healthy, isFalse);
    expect(c.connectionError, isNotNull);
    expect(c.statuses, isEmpty);
  });

  test('refresh: one failing stream is isolated, others stay ok', () async {
    final c = SyncController(
      clientFor((url) {
        if (url.path == '/health') return http.Response(jsonEncode({'status': 'ok'}), 200);
        if (url.path == '/stream/context/changes') {
          return http.Response(jsonEncode({'last_seq': 9}), 200);
        }
        return http.Response('forbidden', 401);
      }),
    );
    await c.refresh();
    expect(c.healthy, isFalse);
    expect(c.statuses[0].ok, isTrue);
    expect(c.statuses[1].ok, isFalse);
    expect(c.statuses[1].error, contains('401'));
  });
}
