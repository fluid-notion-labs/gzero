// org_screen.dart — the shell's top level (3d88): the organization as
// drill-down root. Projects with presence dots, agent counts, unread
// badges and task counts; sync status demoted to a bottom sheet behind
// the app bar's indicator; settings at the far end of the bar.
//
// Navigation model: no tabs, no drawer — the hierarchy IS the
// navigation (see plans/flutter-redesign/ui).

import 'package:flutter/material.dart';

import '../settings/settings_store.dart';
import '../state/comms.dart';
import '../state/overview.dart';
import '../state/sync_controller.dart';
import 'project_screen.dart';
import 'settings_screen.dart';
import 'sync_sheet.dart';
import 'widgets.dart';

class OrgScreen extends StatelessWidget {
  const OrgScreen({
    super.key,
    required this.controller,
    required this.comms,
    required this.onSettingsChanged,
    this.settingsStore,
  });

  final SyncController controller;
  final CommsController comms;
  final VoidCallback onSettingsChanged;
  final SettingsStore? settingsStore;

  String get _orgName {
    final projects = controller.projects;
    if (projects.isEmpty) return 'gzero';
    final first = projects.first.scope.split('/');
    return first.length > 1 ? first.first : 'gzero';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_orgName),
        actions: [
          SyncIndicator(controller: controller),
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            tooltip: 'Settings',
            onPressed: () async {
              await Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => SettingsScreen(store: settingsStore),
                ),
              );
              onSettingsChanged();
            },
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) => ListenableBuilder(
          listenable: comms,
          builder: (context, _) {
            final offline = controller.connectionError != null;
            final summaries = buildProjectSummaries(
              projects: controller.projects,
              sessions: comms.sessions(within: recentWindow),
              unreadFor: comms.unreadFor,
            );
            return Column(
              children: [
                if (offline)
                  _OfflineBanner(
                    message: controller.connectionError!,
                    controller: controller,
                  ),
                Expanded(
                  child: RefreshIndicator(
                    onRefresh: controller.refresh,
                    child: summaries.isEmpty
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
                        : ListView(
                            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                            children: [
                              const SectionHeader(title: 'projects'),
                              for (final summary in summaries)
                                _ProjectCard(
                                  summary: summary,
                                  controller: controller,
                                  comms: comms,
                                ),
                            ],
                          ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner({required this.message, required this.controller});

  final String message;
  final SyncController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.errorContainer,
      child: InkWell(
        onTap: () => showSyncSheet(context, controller),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(
            children: [
              Icon(Icons.cloud_off, size: 18, color: theme.colorScheme.onErrorContainer),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'hub unreachable — $message',
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.onErrorContainer),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A project row: presence dot, name, agents-alive / unread line,
/// open-task count. Tapping drills into the project.
class _ProjectCard extends StatelessWidget {
  const _ProjectCard({
    required this.summary,
    required this.controller,
    required this.comms,
  });

  final ProjectSummary summary;
  final SyncController controller;
  final CommsController comms;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitleParts = <String>[
      if (summary.agentsAlive > 0)
        '${summary.agentsAlive} agent${summary.agentsAlive == 1 ? '' : 's'} alive',
      if (summary.unread > 0) '${summary.unread} unread',
      if (summary.agentsAlive == 0 && summary.unread == 0)
        summary.sessions.isEmpty
            ? 'no recent activity'
            : 'last active ${timeAgo(summary.lastSeen)} ago',
    ];

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => ProjectScreen(
              scope: summary.project.scope,
              controller: controller,
              comms: comms,
            ),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Row(
            children: [
              PresenceDot(bucket: summary.presence),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      summary.project.scope,
                      style: theme.textTheme.titleMedium,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (subtitleParts.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        subtitleParts.join(' · '),
                        style: theme.textTheme.bodySmall,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '${summary.project.openCount} open',
                style: theme.textTheme.bodySmall,
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}
