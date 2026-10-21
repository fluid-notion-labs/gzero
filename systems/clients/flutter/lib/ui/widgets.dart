// widgets.dart — small shared widgets and formatting helpers for the
// redesigned shell (3d88). Presence dots and section headers appear on
// several levels of the hierarchy; timeAgo keeps their subtitles sane.

import 'package:flutter/material.dart';

import '../state/overview.dart';

/// The presence dot: green for alive, grey for recent, nothing when
/// stale (spec: absence is the stale signal, not another color).
class PresenceDot extends StatelessWidget {
  const PresenceDot({super.key, required this.bucket, this.size = 10});

  final PresenceBucket bucket;
  final double size;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return switch (bucket) {
      PresenceBucket.alive => Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: theme.colorScheme.primary,
            shape: BoxShape.circle,
          ),
        ),
      PresenceBucket.recent => Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: theme.colorScheme.outline,
            shape: BoxShape.circle,
          ),
        ),
      PresenceBucket.stale => SizedBox(width: size, height: size),
    };
  }
}

/// A section header on the drill-down screens ("agent sessions",
/// "repos", ...).
class SectionHeader extends StatelessWidget {
  const SectionHeader({super.key, required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 16, 4, 8),
      child: Text(
        title.toUpperCase(),
        style: theme.textTheme.labelMedium?.copyWith(
          color: theme.colorScheme.outline,
          letterSpacing: 1.2,
        ),
      ),
    );
  }
}

/// Compact relative time for subtitles: now / 2m / 3h / 5d, empty when
/// we have no timestamp.
String timeAgo(int lastSeen, {DateTime? now}) {
  if (lastSeen <= 0) return '';
  final at = now ?? DateTime.now();
  final diff = at.difference(DateTime.fromMillisecondsSinceEpoch(lastSeen * 1000));
  if (diff.inMinutes < 1) return 'now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m';
  if (diff.inHours < 24) return '${diff.inHours}h';
  return '${diff.inDays}d';
}
