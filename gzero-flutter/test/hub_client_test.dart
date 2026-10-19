import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:gzero_client/api/hub_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('health: ok passes, auth header sent when token set', () async {
    late Map<String, String> sentHeaders;
    final client = HubClient(
      baseUrl: 'https://hub.test/',
      token: 'secret',
      httpClient: MockClient((req) async {
        sentHeaders = req.headers;
        expect(req.url.path, '/health');
        return http.Response(jsonEncode({'status': 'ok'}), 200);
      }),
    );
    await client.health();
    expect(sentHeaders['authorization'], 'Bearer secret');
  });

  test('health: non-200 and bad body raise HubException', () async {
    final bad = HubClient(
      baseUrl: 'https://hub.test',
      httpClient: MockClient((_) async => http.Response('nope', 500)),
    );
    expect(bad.health(), throwsA(isA<HubException>()));

    final weird = HubClient(
      baseUrl: 'https://hub.test',
      httpClient: MockClient((_) async => http.Response(jsonEncode({'status': '?'}) , 200)),
    );
    expect(weird.health(), throwsA(isA<HubException>()));
  });

  test('headSeq: correct path and query, parses last_seq', () async {
    late Uri sent;
    final client = HubClient(
      baseUrl: 'https://hub.test',
      token: 't',
      httpClient: MockClient((req) async {
        sent = req.url;
        return http.Response(jsonEncode({'last_seq': 42, 'changes': []}), 200);
      }),
    );
    expect(await client.headSeq('context'), 42);
    expect(sent.path, '/stream/context/changes');
    expect(sent.queryParameters['since'], '0');
    expect(sent.queryParameters['limit'], '1');
  });

  test('headSeq: trailing slash in base url is tolerated', () async {
    final client = HubClient(
      baseUrl: 'https://hub.test///',
      httpClient: MockClient((req) async => http.Response(jsonEncode({'last_seq': 7}), 200)),
    );
    expect(await client.headSeq('comms'), 7);
  });

  test('no auth header when token empty', () async {
    late Map<String, String> sentHeaders;
    final client = HubClient(
      baseUrl: 'https://hub.test',
      httpClient: MockClient((req) async {
        sentHeaders = req.headers;
        return http.Response(jsonEncode({'status': 'ok'}), 200);
      }),
    );
    await client.health();
    expect(sentHeaders.containsKey('authorization'), isFalse);
  });
}
