// session_screen.dart — the shell's deepest level (3d88): one agent
// session. Header with presence, a meta strip (machine · cwd · scope),
// and the conversation (chat.dart widgets). Mark-read on open, as the
// v0 messages screen did. A slot is reserved here for the branch/fork
// tree (be36) once session identity becomes fork-based.

import 'package:flutter/material.dart';

import '../state/comms.dart';
import '../state/overview.dart';
import '../state/sync_controller.dart';
import 'chat.dart';
import 'sync_sheet.dart';
import 'widgets.dart';

class SessionScreen extends StatefulWidget {
  const SessionScreen({
    super.key,
    required this.comms,
    required this.session,
    required this.controller,
  });

  final CommsController comms;
  final CommsSession session;
  final SyncController controller;

  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen> {
  final _scroll = ScrollController();
  bool _marking = false;

  @override
  void initState() {
    super.initState();
    // One sync for current data, then mark what we're looking at read.
    () async {
      await widget.comms.sync();
      await _markRead();
    }();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _markRead() async {
    if (_marking) return;
    if (widget.comms.unreadFor(widget.session.id) == 0) return;
    _marking = true;
    try {
      await widget.comms.markRead(widget.session.id);
    } finally {
      _marking = false;
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final session = widget.session;
    final meta = [
      if (session.machine.isNotEmpty) session.machine,
      if (session.cwd.isNotEmpty) session.cwd,
      if (session.scope.isNotEmpty) session.scope,
    ].join(' · ');

    return Scaffold(
      appBar: AppBar(
        title: Text(session.title, overflow: TextOverflow.ellipsis),
        actions: [
          SyncIndicator(controller: widget.controller),
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: Center(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  PresenceDot(bucket: presenceBucket(session.lastSeen), size: 8),
                  const SizedBox(width: 6),
                  Text(
                    timeAgo(session.lastSeen),
                    style: theme.textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: widget.comms,
        builder: (context, _) => Column(
          children: [
            if (meta.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    meta,
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
            if (widget.comms.error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    widget.comms.error!,
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.error),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: () async {
                  await widget.comms.sync();
                  await _markRead();
                },
                child: ChatThread(
                  comms: widget.comms,
                  dest: session.id,
                  scrollController: _scroll,
                ),
              ),
            ),
            ChatComposer(
              comms: widget.comms,
              dest: session.id,
              onSent: _scrollToBottom,
            ),
          ],
        ),
      ),
    );
  }
}
