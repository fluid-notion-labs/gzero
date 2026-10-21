// screens_test.dart — widget tests for the 3d88 shell screens: the org
// root's project cards from injected replicas, drill-down into the
// project's session rows, and the session screen's thread + composer.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gzero_client/api/hub_client.dart';
import 'package:gzero_client/state/comms.dart';
import 'package:gzero_client/state/sync_controller.dart';
import 'package:gzero_client/ui/org_screen.dart';
import 'package:gzero_client/ui/session_screen.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HubClient stubClient() => HubClient(
      baseUrl: 'http://localhost:1',
      token: '',
      httpClient: MockClient((_) async => http.Response('down', 503)),
    );

// Timestamps are relative to real wall-clock time: presence buckets
// compare against DateTime.now(), not a fixture constant.
int get nowSecs => DateTime.now().millisecondsSinceEpoch ~/ 1000;

void main() {
  // testWidgets runs in a fake-async zone: awaiting real IO futures
  // never resumes there, so the temp store is created synchronously.
  SyncController syncWithDoc(Map<String, dynamic> doc) {
    final dir = Directory.systemTemp.createTempSync('gz_screens');
    addTearDown(() => dir.deleteSync(recursive: true));
    final sync = SyncController(stubClient(), docStoreDir: dir);
    (sync.contextDoc as dynamic).docJson = jsonEncode(doc);
    return sync;
  }

  CommsController commsWithDoc(Map<String, dynamic> doc) {
    final c = CommsController(client: stubClient(), storeDir: null, sender: 'tablet-928c8f');
    (c as dynamic).docJson = jsonEncode(doc);
    return c;
  }

  testWidgets('org screen: project cards with presence, unread and open counts', (
    tester,
  ) async {
    final sync = syncWithDoc({
      'items': {
        'fluid-notion-labs/gzero': {
          'a': {'title': 't', 'status': 'in_progress', 'priority': 5},
          'b': {'title': 't', 'status': 'closed'},
        },
      },
    });
    final comms = commsWithDoc({
      'sessions': {
        's1': {
          'machine': 'grater',
          'scope': 'fluid-notion-labs/gzero',
          'cwd': '/x',
          'last_seen': nowSecs - 60,
        },
      },
      'messages': {
        'm1': {'dest': 's1', 'sender': 'someone', 'text': 'ping', 'created': nowSecs},
      },
      'reads': {},
    });
    await tester.pumpWidget(MaterialApp(
      home: OrgScreen(controller: sync, comms: comms, onSettingsChanged: () {}),
    ));
    await tester.pumpAndSettle();

    expect(find.text('fluid-notion-labs/gzero'), findsOneWidget);
    expect(find.textContaining('1 agent alive'), findsOneWidget);
    expect(find.textContaining('1 unread'), findsOneWidget);
    expect(find.text('1 open'), findsOneWidget);
  });

  testWidgets('drill-down: org card tap opens project with session rows', (
    tester,
  ) async {
    final sync = syncWithDoc({
      'items': {
        'fluid-notion-labs/gzero': {
          'a': {'title': 't', 'status': 'in_progress', 'priority': 5},
        },
      },
    });
    final comms = commsWithDoc({
      'sessions': {
        's1': {
          'machine': 'grater',
          'scope': 'fluid-notion-labs/gzero',
          'cwd': '/x',
          'last_seen': nowSecs - 60,
        },
      },
      'messages': {},
      'reads': {},
    });
    await tester.pumpWidget(MaterialApp(
      home: OrgScreen(controller: sync, comms: comms, onSettingsChanged: () {}),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('fluid-notion-labs/gzero'));
    await tester.pumpAndSettle();

    // Project screen: alive session row (title = scope tail + machine).
    expect(find.text('gzero · grater'), findsOneWidget);
    expect(find.text('/x'), findsOneWidget);
    expect(find.text('AGENT SESSIONS'), findsOneWidget);
    expect(find.text('REPOS'), findsOneWidget);
  });

  testWidgets('session screen: meta strip, thread bubble, composer', (
    tester,
  ) async {
    final sync = syncWithDoc({'items': {}});
    final comms = commsWithDoc({
      'sessions': {
        's1': {
          'machine': 'grater',
          'scope': 'fluid-notion-labs/gzero',
          'cwd': '/x',
          'last_seen': nowSecs - 60,
        },
      },
      'messages': {
        'm1': {'dest': 's1', 'sender': 'someone', 'text': 'ping', 'created': nowSecs},
        'm2': {'dest': 's1', 'sender': 'tablet-928c8f', 'text': 'pong', 'created': nowSecs},
      },
      'reads': {'m1': nowSecs},
    });
    final session = comms.sessions().first;
    await tester.pumpWidget(MaterialApp(
      home: SessionScreen(controller: sync, comms: comms, session: session),
    ));
    await tester.pumpAndSettle();

    expect(find.text('grater · /x · fluid-notion-labs/gzero'), findsOneWidget);
    expect(find.text('ping'), findsOneWidget);
    expect(find.text('pong'), findsOneWidget);
    // Mine shows delivery state ('sent' until a read lands); theirs
    // shows no suffix.
    expect(find.textContaining('sent'), findsOneWidget);
    // Sender identity present, dest set → send enabled.
    final send = tester.widget<IconButton>(
      find.ancestor(of: find.byTooltip('Send'), matching: find.byType(IconButton)).first,
    );
    expect(send.onPressed, isNotNull);
  });

  testWidgets('session screen: composer disabled without sender identity', (
    tester,
  ) async {
    final sync = syncWithDoc({'items': {}});
    final comms = CommsController(client: stubClient(), storeDir: null);
    (comms as dynamic).docJson = jsonEncode({
      'sessions': {
        's1': {
          'machine': 'grater',
          'scope': 'fluid-notion-labs/gzero',
          'cwd': '/x',
          'last_seen': nowSecs - 60,
        },
      },
      'messages': {},
      'reads': {},
    });
    final session = comms.sessions().first;
    await tester.pumpWidget(MaterialApp(
      home: SessionScreen(controller: sync, comms: comms, session: session),
    ));
    await tester.pumpAndSettle();

    expect(find.text('set a sender identity in settings first'), findsOneWidget);
    final send = tester.widget<IconButton>(
      find.ancestor(of: find.byTooltip('Send'), matching: find.byType(IconButton)).first,
    );
    expect(send.onPressed, isNull);
  });
}
