// sync_sheet.dart — the sync status surface (3d88). The v0 home screen's
// status card demoted to a bottom sheet behind the app bar's sync
// indicator, reachable from any level of the hierarchy.

import 'package:flutter/material.dart';

import '../state/sync_controller.dart';

/// Open the sync status sheet from anywhere (callers pass their
/// SyncController explicitly — modal routes don't share context).
Future<void> showSyncSheet(BuildContext context, SyncController controller) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (_) => SyncSheet(controller: controller),
  );
}

/// The sheet content.
class SyncSheet extends StatelessWidget {
  const SyncSheet({super.key, required this.controller});

  final SyncController controller;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
      child: ListenableBuilder(
        listenable: controller,
        builder: (context, _) => _SyncStatus(controller: controller),
      ),
    );
  }
}

/// The app bar's sync indicator: state-colored icon, tap opens the
/// sheet. Shared by every level of the hierarchy.
class SyncIndicator extends StatelessWidget {
  const SyncIndicator({super.key, required this.controller});

  final SyncController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final c = controller;
        return IconButton(
          icon: Icon(
            c.connectionError != null
                ? Icons.cloud_off
                : c.busy
                    ? Icons.sync
                    : c.healthy
                        ? Icons.cloud_done
                        : Icons.cloud_queue,
            color: c.connectionError != null ? Theme.of(context).colorScheme.error : null,
          ),
          tooltip: 'Sync status',
          onPressed: () => showSyncSheet(context, controller),
        );
      },
    );
  }
}

class _SyncStatus extends StatelessWidget {
  const _SyncStatus({required this.controller});

  final SyncController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = controller;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
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
        ),
        if (c.connectionError != null) ...[
          const SizedBox(height: 8),
          Text(c.connectionError!, style: theme.textTheme.bodySmall),
        ],
        const SizedBox(height: 8),
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
          if ((s.name == 'context' ? c.contextDoc : c.commsDoc)?.statusLine
              case final line?)
            Padding(
              padding: const EdgeInsets.only(left: 26, bottom: 4),
              child: Text(
                line,
                style: theme.textTheme.bodySmall
                    ?.copyWith(fontStyle: FontStyle.italic),
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
    );
  }
}
