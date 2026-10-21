// comms_test.dart — the messaging data plane: parsing, destination
// filtering, TTL and presence freshness, sender validation. The
// network/FFI halves are exercised on-device; these tests cover what
// runs without them.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:gzero_client/api/hub_client.dart';
import 'package:gzero_client/settings/settings_store.dart';
import 'package:gzero_client/state/comms.dart';

void main() {
  test('messages: destination filter, ordering, TTL and read status', () {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final doc = {
      'messages': {
        'a': {'dest': 'agent-1', 'sender': 'tablet-01', 'text': 'first', 'created': now - 100},
        'b': {'dest': 'agent-2', 'sender': 'agent-1', 'text': 'other convo', 'created': now - 50},
        'c': {'dest': 'agent-1', 'sender': 'agent-1', 'text': 'second', 'created': now - 10},
        'old': {'dest': 'agent-1', 'sender': 'tablet-01', 'text': 'expired', 'created': now - 8 * 24 * 3600},
      },
      'reads': {'a': now - 90},
    };
    final controller = CommsController(client: _stubClient(), storeDir: null);
    // inject the parsed doc directly through docJson
    (controller as dynamic).docJson = jsonEncode(doc);

    final thread = controller.messages('agent-1');
    expect(thread.map((m) => m.text).toList(), ['first', 'second'], reason: 'other dest and expired dropped, ordered by created');
    expect(thread[0].unread, isFalse, reason: 'reads/<id> present');
    expect(thread[1].unread, isTrue, reason: 'no read entry');
    expect(controller.messages('agent-2'), hasLength(1));
    expect(controller.messages('nobody'), isEmpty);
  });

  test('sessions: presence freshness filter, newest first, title', () {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final doc = {
      'sessions': {
        's-live': {'machine': 'grater', 'scope': 'fluid-notion-labs/gzero', 'label': 'panel dev', 'last_seen': now - 60},
        's-stale': {'machine': 'laptop', 'scope': 'fluid-notion-labs/gzero', 'label': '', 'last_seen': now - 10 * 60},
        's-recent': {'machine': 'laptop', 'scope': 'fluid-notion-labs/gzero', 'label': '', 'last_seen': now - 30},
      },
    };
    final controller = CommsController(client: _stubClient(), storeDir: null);
    (controller as dynamic).docJson = jsonEncode(doc);

    final sessions = controller.sessions();
    expect(sessions.map((s) => s.id).toList(), ['s-recent', 's-live'], reason: 'stale presence dropped, newest first');
    expect(sessions[1].title, 'panel dev (grater)');
    expect(sessions[0].title, contains('laptop'));
  });

  test('sender validation: send is a no-op without identity or store', () async {
    final controller = CommsController(client: _stubClient(), storeDir: null);
    expect(await controller.send('x', 'hi'), isNull, reason: 'no doc store');
    expect(controller.error, isNull);
  });

  test('newSender: prefixed and unique enough', () {
    final ids = {for (var i = 0; i < 20; i++) newSender()};
    expect(ids, hasLength(20));
    expect(ids.first, startsWith('tablet-'));
  });
}

HubClient _stubClient() {
  // Not used by the code paths under test; a client with a bogus URL.
  return HubClient(baseUrl: 'http://127.0.0.1:1', token: '');
}
