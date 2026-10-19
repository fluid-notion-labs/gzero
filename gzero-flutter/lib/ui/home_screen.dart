// home_screen.dart — the Surface plane, v0: sync status card first.
//
// The status card is the observable of the whole stack (per
// flutter-client.md): hub reachable or not, per-stream head seqs. The
// projects list and messaging screens stack on top as the data planes
// come online.

import 'package:flutter/material.dart';

import '../settings/settings_store.dart';
import '../state/sync_controller.dart';
import 'settings_screen.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({
    super.key,
    required this.controller,
    required this.onSettingsChanged,
    this.settingsStore,
  });

  final SyncController controller;
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
              Text(
                'projects',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('coming up — needs the projects data plane (automerge in dart or a hub view)'),
                ),
              ),
            ],
          ),
        ),
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
            for (final s in c.statuses)
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
