// overview_test.dart — the shell's model projection (presence buckets,
// project summaries, scope matching).

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:gzero_client/api/hub_client.dart';

import 'package:gzero_client/state/comms.dart';
import 'package:gzero_client/state/overview.dart';
import 'package:gzero_client/state/projects.dart';

DateTime now = DateTime(2026, 10, 21, 12);

CommsSession session(String id, {String scope = 'gzero', int ageMinutes = 1, String label = ''}) {
  return CommsSession(
    id: id,
    machine: 'nick-MacPro5-1',
    scope: scope,
    label: label,
    cwd: '/home/nick/$scope',
    startedAt: 0,
    lastSeen: now.millisecondsSinceEpoch ~/ 1000 - ageMinutes * 60,
  );
}

Project project(String scope, {int open = 0}) {
  final items = [for (var i = 0; i < open; i++) ProjectItem(id: 'i$i', title: 'item $i', status: 'open')];
  return Project(scope: scope, items: items);
}

void main() {
  test('presence buckets: alive ≤ 5 min, recent ≤ 24 h, stale beyond', () {
    expect(presenceBucket(session('a', ageMinutes: 2).lastSeen, now: now), PresenceBucket.alive);
    expect(presenceBucket(session('a', ageMinutes: 30).lastSeen, now: now), PresenceBucket.recent);
    expect(presenceBucket(session('a', ageMinutes: 25 * 60).lastSeen, now: now), PresenceBucket.stale);
    expect(presenceBucket(0, now: now), PresenceBucket.stale);
  });

  test('scopeMatches on short and fully qualified names', () {
    expect(scopeMatches('gzero', 'fluid-notion-labs/gzero'), isTrue);
    expect(scopeMatches('fluid-notion-labs/gzero', 'gzero'), isTrue);
    expect(scopeMatches('gzero', 'fluid-notion-labs/explorations'), isFalse);
    expect(scopeMatches('', 'gzero'), isFalse);
  });

  test('summaries join projects with sessions and unread counts', () {
    final summaries = buildProjectSummaries(
      projects: [project('fluid-notion-labs/gzero', open: 8), project('fluid-notion-labs/lonely')],
      sessions: [
        session('s1', ageMinutes: 2),
        session('s2', scope: 'fluid-notion-labs/gzero', ageMinutes: 30),
        session('s3', scope: 'other', ageMinutes: 1),
      ],
      unreadFor: (id) => id == 's2' ? 3 : 0,
      now: now,
    );

    expect(summaries, hasLength(2));
    final gzero = summaries.firstWhere((s) => s.project.scope == 'fluid-notion-labs/gzero');
    expect(gzero.sessions, hasLength(2));
    expect(gzero.sessions[0].session.id, 's1'); // alive first
    expect(gzero.sessions[0].presence, PresenceBucket.alive);
    expect(gzero.sessions[1].session.id, 's2');
    expect(gzero.agentsAlive, 1);
    expect(gzero.unread, 3);
    expect(gzero.presence, PresenceBucket.alive);

    final lonely = summaries.firstWhere((s) => s.project.scope == 'fluid-notion-labs/lonely');
    expect(lonely.sessions, isEmpty);
    expect(lonely.presence, PresenceBucket.stale);
  });

  test('unreadFor counts only unread messages (comms controller)', () {
    final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final controller = CommsController(client: _stubClient(), storeDir: null);
    // inject the parsed doc directly through docJson (same as comms_test)
    (controller as dynamic).docJson = jsonEncode({
      'messages': {
        'm1': {'dest': 's1', 'sender': 'agent', 'text': 'hi', 'created': nowSec - 100},
        'm2': {'dest': 's1', 'sender': 'agent', 'text': 'again', 'created': nowSec - 90},
      },
      'reads': {'m2': nowSec - 80},
    });
    expect(controller.unreadFor('s1'), 1);
  });
}

HubClient _stubClient() => HubClient(baseUrl: 'http://localhost:1', token: '');
