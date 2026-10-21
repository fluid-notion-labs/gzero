// overview.dart — the model projection for the redesigned shell (3d88).
//
// Pure functions joining the two data planes the shell reads — projects
// (context doc) and comms presence — into the views the screens render:
// presence buckets and per-project summaries. No Flutter imports; the
// screens stay dumb and this stays unit-testable.

import 'comms.dart';
import 'projects.dart';

/// How fresh an agent's presence must be to render as alive/recent.
/// Alive mirrors PRESENCE_TTL_SECS (comms.dart); recent is the shell's
/// own "was around today" window; anything older is stale.
const Duration recentWindow = Duration(hours: 24);

/// Presence buckets for the dots: alive (green), recent (grey),
/// stale (no dot).
enum PresenceBucket { alive, recent, stale }

PresenceBucket presenceBucket(int lastSeen, {DateTime? now}) {
  final at = now ?? DateTime.now();
  final age = at.difference(DateTime.fromMillisecondsSinceEpoch(lastSeen * 1000));
  if (lastSeen <= 0) return PresenceBucket.stale;
  if (age <= presenceTtl) return PresenceBucket.alive;
  if (age <= recentWindow) return PresenceBucket.recent;
  return PresenceBucket.stale;
}

/// One session as the shell renders it: presence + unread attached.
class SessionSummary {
  const SessionSummary({
    required this.session,
    required this.presence,
    required this.unread,
  });

  final CommsSession session;
  final PresenceBucket presence;
  final int unread;
}

/// One project as the shell renders it: its sessions, how many agents
/// are alive, total unread, and when anything last moved.
class ProjectSummary {
  const ProjectSummary({
    required this.project,
    required this.sessions,
    required this.unread,
  });

  final Project project;
  final List<SessionSummary> sessions;
  final int unread;

  int get agentsAlive =>
      sessions.where((s) => s.presence == PresenceBucket.alive).length;

  /// Newest session presence in the project, for the card's dot.
  PresenceBucket get presence {
    var best = PresenceBucket.stale;
    for (final s in sessions) {
      if (s.presence == PresenceBucket.alive) return PresenceBucket.alive;
      if (s.presence == PresenceBucket.recent) best = PresenceBucket.recent;
    }
    return best;
  }

  int get lastSeen {
    var newest = 0;
    for (final s in sessions) {
      if (s.session.lastSeen > newest) newest = s.session.lastSeen;
    }
    return newest;
  }
}

/// Sessions belong to a project by scope. Both sides may be short
/// ("gzero") or fully qualified ("fluid-notion-labs/gzero"); match on
/// the last path segment.
bool scopeMatches(String sessionScope, String projectScope) {
  final a = _tail(sessionScope.trim());
  final b = _tail(projectScope.trim());
  return a.isNotEmpty && a == b;
}

String _tail(String s) {
  final parts = s.split('/');
  return parts.isEmpty ? s : parts.last;
}

/// Build the per-project summaries the shell renders. `unreadFor`
/// supplies the unread count for one session id (the comms controller
/// owns that calculation; the projection stays pure).
List<ProjectSummary> buildProjectSummaries({
  required List<Project> projects,
  required List<CommsSession> sessions,
  required int Function(String sessionId) unreadFor,
  DateTime? now,
}) {
  final out = <ProjectSummary>[];
  for (final project in projects) {
    final inProject = <SessionSummary>[];
    for (final session in sessions) {
      if (!scopeMatches(session.scope, project.scope)) continue;
      inProject.add(SessionSummary(
        session: session,
        presence: presenceBucket(session.lastSeen, now: now),
        unread: unreadFor(session.id),
      ));
    }
    inProject.sort((a, b) {
      // alive first, then recent; newest within each bucket
      final bucket = a.presence.index.compareTo(b.presence.index);
      if (bucket != 0) return bucket;
      return b.session.lastSeen.compareTo(a.session.lastSeen);
    });
    var unread = 0;
    for (final s in inProject) {
      unread += s.unread;
    }
    out.add(ProjectSummary(project: project, sessions: inProject, unread: unread));
  }
  return out;
}
