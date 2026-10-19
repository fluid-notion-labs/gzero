// projects_screen.dart — the projects surface, v0 (read-only).
//
// Projects come out of the context doc replica (state/projects.dart):
// one row per scope, tap through to its work items. Item editing (via
// project streams) comes later; this screen only reads.

import 'package:flutter/material.dart';

import '../state/projects.dart';
import '../state/sync_controller.dart';

class ProjectsScreen extends StatelessWidget {
  const ProjectsScreen({super.key, required this.controller});

  final SyncController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final projects = controller.projects;
        return Scaffold(
          appBar: AppBar(title: const Text('projects')),
          body: RefreshIndicator(
            onRefresh: controller.refresh,
            child: projects.isEmpty
                ? ListView(
                    children: const [
                      Padding(
                        padding: EdgeInsets.all(32),
                        child: Center(
                          child: Text(
                            'no projects yet — they appear once the context doc syncs',
                            textAlign: TextAlign.center,
                          ),
                        ),
                      ),
                    ],
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: projects.length,
                    itemBuilder: (context, i) {
                      final p = projects[i];
                      return Card(
                        child: ListTile(
                          title: Text(p.scope, style: Theme.of(context).textTheme.titleMedium),
                          subtitle: Text('${p.openCount} open · ${p.closedCount} closed'),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute<void>(builder: (_) => ProjectDetailScreen(project: p)),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        );
      },
    );
  }
}

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
