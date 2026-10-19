// projects.dart — the projects data plane for the phone (read-only).
//
// The context doc's root `items` map is the source of truth:
// Map<scope, Map<id, item>> — the same schema src/items.rs writes on
// desktop. A stream named `project/<scope>` IS a project, but its work
// items live in the shared context doc under that scope, so reading the
// context doc is all the phone needs: no new hub endpoints.
//
// Parsed from the FFI JSON view (gz_doc_json), not from Dart-side
// automerge — Dart owns none of the CRDT.

import 'dart:convert';

/// One work item under a project scope.
class ProjectItem {
  ProjectItem({required this.id, required this.title, this.status, this.priority});

  final String id;
  final String title;
  final String? status;
  final int? priority;

  bool get open => status != 'closed';

  factory ProjectItem.fromJson(String id, Map<String, dynamic> json) {
    return ProjectItem(
      id: id,
      title: (json['title'] as String?) ?? id,
      status: json['status'] as String?,
      priority: json['priority'] is num ? (json['priority'] as num).toInt() : null,
    );
  }
}

/// A project: a scope key and its work items.
class Project {
  Project({required this.scope, required this.items});

  /// Display name: `project/<scope>` is the stream; the scope is the
  /// short name.
  final String scope;
  final List<ProjectItem> items;

  Iterable<ProjectItem> get openItems => items.where((i) => i.open);
  int get openCount => openItems.length;
  int get closedCount => items.length - openCount;

  factory Project.fromJson(String scope, Map<String, dynamic> raw) {
    final items = <ProjectItem>[];
    raw.forEach((id, value) {
      if (value is Map<String, dynamic>) items.add(ProjectItem.fromJson(id, value));
    });
    items.sort(_itemOrder);
    return Project(scope: scope, items: items);
  }
}

/// Parse the projects out of a context-doc JSON view (gz_doc_json
/// output). Returns an empty list for null, an unparseable doc, or a
/// doc without items — the caller renders an empty state either way.
List<Project> parseProjects(String? docJson) {
  if (docJson == null || docJson.isEmpty) return const [];
  final Object? root;
  try {
    root = jsonDecode(docJson);
  } on FormatException {
    return const [];
  }
  if (root is! Map<String, dynamic>) return const [];
  final items = root['items'];
  if (items is! Map<String, dynamic>) return const [];

  final projects = <Project>[];
  items.forEach((scope, raw) {
    if (raw is Map<String, dynamic>) projects.add(Project.fromJson(scope, raw));
  });
  projects.sort((a, b) => a.scope.compareTo(b.scope));
  return projects;
}

int _itemOrder(ProjectItem a, ProjectItem b) {
  // open first, then priority (larger = more important), then id for a
  // stable tiebreak
  final open = (a.open ? 0 : 1).compareTo(b.open ? 0 : 1);
  if (open != 0) return open;
  final p = (b.priority ?? 0).compareTo(a.priority ?? 0);
  if (p != 0) return p;
  return a.id.compareTo(b.id);
}
