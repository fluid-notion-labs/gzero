// project_screen.dart — the shell's middle level (3d88): one project's
// agent sessions (alive first, recent next, older folded away), its
// repos, and a teaser into its work items. The session rows are the
// self-contained widgets; the screen composes them.

import 'package:flutter/material.dart';

import '../state/comms.dart';
import '../state/overview.dart';
import '../state/projects.dart';
import '../state/sync_controller.dart';
import 'projects_screen.dart';
import 'session_screen.dart';
import 'sync_sheet.dart';
import 'widgets.dart';

/// How far back the "older" expander reaches (presence beyond this is
/// simply not shown).
const Duration olderWindow = Duration(days: 7);

class ProjectScreen extends StatelessWidget {
  const ProjectScreen({
    super.key,
    required this.scope,
    required this.controller,
    required this.comms,
  });

  final String scope;
  final SyncController controller;
  final CommsController comms;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_tail(scope)),
        actions: [SyncIndicator(controller: controller)],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) => ListenableBuilder(
          listenable: comms,
          builder: (context, _) {
            // One summary per project; keep the one matching this scope.
            final summaries = buildProjectSummaries(
              projects: controller.projects,
              sessions: comms.sessions(within: olderWindow),
              unreadFor: comms.unreadFor,
            );
            final summary = summaries
                .where((s) => _tail(s.project.scope) == _tail(scope))
                .firstOrNull;
            final current = summary?.project ??
                controller.projects
                    .where((p) => _tail(p.scope) == _tail(scope))
                    .firstOrNull;
            final sessions = summary?.sessions ?? const <SessionSummary>[];
            final shown = sessions
                .where((s) => s.presence != PresenceBucket.stale)
                .toList();
            final older = sessions
                .where((s) => s.presence == PresenceBucket.stale)
                .toList();

            return RefreshIndicator(
              onRefresh: controller.refresh,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                children: [
                  const SectionHeader(title: 'agent sessions'),
                  if (shown.isEmpty && older.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Text(
                        'no agent sessions yet — they appear when agents sync',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  for (final s in shown)
                    _SessionRow(summary: s, comms: comms, controller: controller),
                  if (older.isNotEmpty)
                    ExpansionTile(
                      title: Text(
                        'older (${older.length})',
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                      children: [
                        for (final s in older)
                          _SessionRow(
                            summary: s,
                            comms: comms,
                            controller: controller,
                          ),
                      ],
                    ),
                  const SectionHeader(title: 'repos'),
                  _RepoStubCard(scope: scope),
                  if (current != null) ...[
                    const SectionHeader(title: 'items'),
                    _ItemsTeaser(project: current),
                  ],
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}

String _tail(String s) {
  final parts = s.split('/');
  return parts.isEmpty ? s : parts.last;
}

/// One agent session row: presence dot, title, machine/cwd line, last
/// seen, unread badge. Tapping opens the conversation.
class _SessionRow extends StatelessWidget {
  const _SessionRow({
    required this.summary,
    required this.comms,
    required this.controller,
  });

  final SessionSummary summary;
  final CommsController comms;
  final SyncController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final session = summary.session;
    final subtitle = [
      if (session.machine.isNotEmpty) session.machine,
      if (session.cwd.isNotEmpty) session.cwd,
    ].join(' · ');

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => SessionScreen(
              comms: comms,
              session: session,
              controller: controller,
            ),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            children: [
              PresenceDot(bucket: summary.presence),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      session.title,
                      style: theme.textTheme.titleSmall,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (subtitle.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        style: theme.textTheme.bodySmall,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                timeAgo(session.lastSeen),
                style: theme.textTheme.bodySmall,
              ),
              if (summary.unread > 0) ...[
                const SizedBox(width: 8),
                Badge(label: Text('${summary.unread}')),
              ] else
                const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}

/// Repos section placeholder (phase 2): the project's repository row.
class _RepoStubCard extends StatelessWidget {
  const _RepoStubCard({required this.scope});

  final String scope;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: ListTile(
        leading: const Icon(Icons.folder_outlined),
        title: Text(scope, overflow: TextOverflow.ellipsis),
        trailing: Text(
          'main ↑↓',
          style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
        ),
        enabled: false,
      ),
    );
  }
}

/// Items teaser: tap through to the work items list (existing
/// ProjectDetailScreen).
class _ItemsTeaser extends StatelessWidget {
  const _ItemsTeaser({required this.project});

  final Project project;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        leading: const Icon(Icons.checklist_outlined),
        title: Text('${project.openCount} open · ${project.closedCount} closed'),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => ProjectDetailScreen(project: project),
          ),
        ),
      ),
    );
  }
}
