// home_screen.dart — the Surface plane, v0: sync status card first.
//
// The status card is the observable of the whole stack (per
// flutter-client.md): hub reachable or not, per-stream head seqs. The
// projects list and messaging screens stack on top as the data planes
// come online.

import 'package:flutter/material.dart';

import '../settings/settings_store.dart';
import '../state/comms.dart';
import '../state/projects.dart';
import '../state/sync_controller.dart';
import 'messages_screen.dart';
import 'projects_screen.dart';
import 'settings_screen.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('gzero'),
        actions: [
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
        builder: (context, _) => RefreshIndicator(
          onRefresh: controller.refresh,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _SyncCard(controller: controller),
              const SizedBox(height: 16),
              _MessagesCard(comms: comms),
              const SizedBox(height: 16),
              _ProjectsCard(controller: controller),
            ],
          ),
        ),
      ),
    );
  }
}

class _MessagesCard extends StatelessWidget {
  const _MessagesCard({required this.comms});

  final CommsController comms;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sessions = comms.sessions();
    final unread = [for (final s in sessions) ...comms.messages(s.id)].where((m) => m.unread).length;

    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => MessagesScreen(comms: comms)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Icon(Icons.forum_outlined, color: unread > 0 ? theme.colorScheme.primary : null),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Messages', style: theme.textTheme.titleMedium),
                    const SizedBox(height: 2),
                    Text(
                      sessions.isEmpty
                          ? 'no active agents'
                          : '${sessions.length} active session${sessions.length == 1 ? '' : 's'}'
                          '${unread > 0 ? ' · $unread unread' : ''}',
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              if (unread > 0)
                Badge(label: Text('$unread'))
              else
                const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}

class _ProjectsCard extends StatelessWidget {
  const _ProjectsCard({required this.controller});

  final SyncController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final projects = controller.projects;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.folder_outlined),
                const SizedBox(width: 12),
                Expanded(child: Text('projects', style: theme.textTheme.titleMedium)),
                IconButton(
                  icon: const Icon(Icons.open_in_new),
                  tooltip: 'Open projects',
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(builder: (_) => ProjectsScreen(controller: controller)),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            if (projects.isEmpty)
              Text(
                'nothing yet — waiting on the context doc',
                style: theme.textTheme.bodySmall,
              )
            else ...[
              for (final p in projects.take(3))
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: _ProjectRow(project: p),
                ),
              if (projects.length > 3)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    '+${projects.length - 3} more',
                    style: theme.textTheme.bodySmall,
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow({required this.project});

  final Project project;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => ProjectDetailScreen(project: project)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(project.scope, style: theme.textTheme.bodyMedium, overflow: TextOverflow.ellipsis),
          ),
          Text(
            '${project.openCount} open',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class _SyncCard extends StatelessWidget {
  const _SyncCard({required this.controller});

  final SyncController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = controller;

    final header = Row(
      children: [
        Icon(
          c.connectionError != null
              ? Icons.cloud_off
              : c.busy
              ? Icons.sync
              : c.healthy
              ? Icons.cloud_done
              : Icons.cloud_queue,
          color: c.connectionError != null ? theme.colorScheme.error : null,
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            c.busy
                ? 'syncing…'
                : c.connectionError != null
                ? 'hub unreachable'
                : c.healthy
                ? 'synced with hub'
                : 'no streams checked yet',
            style: theme.textTheme.titleMedium,
          ),
        ),
        IconButton(
          icon: const Icon(Icons.refresh),
          tooltip: 'Refresh',
          onPressed: c.busy ? null : () => c.refresh(),
        ),
      ],
    );

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            header,
            if (c.connectionError != null) ...[
              const SizedBox(height: 8),
              Text(c.connectionError!, style: theme.textTheme.bodySmall),
            ],
            const SizedBox(height: 12),
            for (final s in c.statuses) ...[
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Icon(
                      s.ok ? Icons.check_circle_outline : Icons.error_outline,
                      size: 18,
                      color: s.ok ? null : theme.colorScheme.error,
                    ),
                    const SizedBox(width: 8),
                    Text(s.name, style: theme.textTheme.bodyMedium),
                    const Spacer(),
                    Text(
                      s.ok ? 'seq ${s.lastSeq}' : (s.error ?? 'error'),
                      style: theme.textTheme.bodySmall,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              for (final s in c.statuses)
                if (s.name == 'context' || s.name == 'comms')
                  if ((s.name == 'context' ? c.contextDoc : c.commsDoc)?.statusLine
                      case final line?)
                    Padding(
                      padding: const EdgeInsets.only(left: 26, bottom: 4),
                      child: Text(
                        line,
                        style: theme.textTheme.bodySmall?.copyWith(fontStyle: FontStyle.italic),
                      ),
                    ),
            ],
            if (c.lastChecked != null) ...[
              const SizedBox(height: 8),
              Text(
                'checked ${TimeOfDay.fromDateTime(c.lastChecked!).format(context)}',
                style: theme.textTheme.bodySmall,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
