// projects_test.dart — parsing the context doc JSON view into projects.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:gzero_client/state/projects.dart';

String docJson(Map<String, dynamic> root) => jsonEncode(root);

void main() {
  test('parses scopes and items out of the items map', () {
    final projects = parseProjects(docJson({
      'items': {
        'project/tablet': {
          'itm_1': {'title': 'wire up projects', 'status': 'in_progress', 'priority': 5},
          'itm_2': {'title': 'done thing', 'status': 'closed'},
        },
        'comms': {},
      },
    }));

    expect(projects, hasLength(2));
    expect(projects[0].scope, 'comms');
    expect(projects[1].scope, 'project/tablet');
    final tablet = projects[1];
    expect(tablet.items, hasLength(2));
    // open before closed, higher priority first
    expect(tablet.items[0].title, 'wire up projects');
    expect(tablet.items[0].open, isTrue);
    expect(tablet.items[0].priority, 5);
    expect(tablet.items[1].status, 'closed');
    expect(tablet.openCount, 1);
    expect(tablet.closedCount, 1);
  });

  test('empty / null / malformed inputs render as no projects', () {
    expect(parseProjects(null), isEmpty);
    expect(parseProjects(''), isEmpty);
    expect(parseProjects('not json'), isEmpty);
    expect(parseProjects(docJson({})), isEmpty);
    expect(parseProjects(docJson({'items': 'nope'})), isEmpty);
  });

  test('items missing a title fall back to their id', () {
    final projects = parseProjects(docJson({
      'items': {
        'p': {'x1': {'status': 'open'}},
      },
    }));
    expect(projects.single.items.single.id, 'x1');
    expect(projects.single.items.single.title, 'x1');
    expect(projects.single.openCount, 1);
  });

  test('malformed item values are skipped, siblings survive', () {
    final projects = parseProjects(docJson({
      'items': {
        'p': {
          'good': {'title': 'ok'},
          'bad': 'not a map',
        },
      },
    }));
    expect(projects.single.items, hasLength(1));
    expect(projects.single.items.single.title, 'ok');
  });
}
