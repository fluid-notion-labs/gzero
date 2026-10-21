// projects_screen.dart — the work items detail surface (read-only),
// reached from a project screen's items teaser. The projects list
// itself lives on the org screen now (3d88).

import 'package:flutter/material.dart';

import '../state/projects.dart';

class ProjectDetailScreen extends StatelessWidget {
  const ProjectDetailScreen({super.key, required this.project});

  final Project project;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(project.scope)),
      body: project.items.isEmpty
          ? const Center(child: Text('no items'))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                for (final item in project.items)
                  Card(
                    child: ListTile(
                      leading: _StatusDot(status: item.status),
                      title: Text(item.title),
                      subtitle: item.priority != null && item.priority != 0
                          ? Text('priority ${item.priority}')
                          : null,
                      trailing: item.open
                          ? null
                          : Icon(Icons.check, size: 18, color: theme.colorScheme.outline),
                    ),
                  ),
              ],
            ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});

  final String? status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = switch (status) {
      'in_progress' => theme.colorScheme.primary,
      'closed' => theme.colorScheme.outline,
      _ => theme.colorScheme.secondary, // open / unknown
    };
    return CircleAvatar(radius: 6, backgroundColor: color);
  }
}
