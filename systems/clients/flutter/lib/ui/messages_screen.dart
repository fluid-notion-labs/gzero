// messages_screen.dart — the conversation view: pick a destination from
// the live sessions, read the thread, send, and mark what you saw read.
//
// Data plane is CommsController (comms.dart); this is pure Surface.

import 'package:flutter/material.dart';

import '../state/comms.dart';

class MessagesScreen extends StatefulWidget {
  const MessagesScreen({super.key, required this.comms, this.initialDestination});

  final CommsController comms;
  final String? initialDestination;

  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen> {
  late String _dest;
  final _composer = TextEditingController();
  final _scroll = ScrollController();
  bool _marking = false;

  @override
  void initState() {
    super.initState();
    _dest = widget.initialDestination ?? widget.comms.sessions().firstOrNull?.id ?? '';
    // One sync to have current data, then mark what we're looking at read.
    () async {
      await widget.comms.sync();
      await _markRead();
    }();
  }

  @override
  void dispose() {
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _markRead() async {
    if (_marking || _dest.isEmpty) return;
    final unread = widget.comms.messages(_dest).any((m) => m.unread);
    if (!unread) return;
    _marking = true;
    try {
      await widget.comms.markRead(_dest);
    } finally {
      _marking = false;
    }
  }

  Future<void> _refresh() async {
    await widget.comms.sync();
    await _markRead();
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty || _dest.isEmpty) return;
    _composer.clear();
    await widget.comms.send(_dest, text);
    // keep the newest message in view
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final comms = widget.comms;
    return Scaffold(
      appBar: AppBar(title: const Text('messages')),
      body: ListenableBuilder(
        listenable: comms,
        builder: (context, _) {
          final sessions = comms.sessions();
          final knownDest = sessions.any((s) => s.id == _dest);
          final messages = _dest.isEmpty ? const <CommsMessage>[] : comms.messages(_dest);
          final theme = Theme.of(context);

          final picker = DropdownButtonFormField<String>(
            initialValue: _dest.isEmpty ? null : _dest,
            decoration: const InputDecoration(labelText: 'conversation with', border: OutlineInputBorder()),
            items: [
              for (final s in sessions)
                DropdownMenuItem(value: s.id, child: Text(s.title, overflow: TextOverflow.ellipsis)),
              if (!knownDest && _dest.isNotEmpty)
                DropdownMenuItem(value: _dest, child: Text(_dest, overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (v) => setState(() {
              _dest = v ?? '';
              _markRead();
            }),
          );

          final thread = Expanded(
            child: messages.isEmpty
                ? Center(
                    child: Text(
                      _dest.isEmpty ? 'pick a conversation' : 'no messages yet',
                      style: theme.textTheme.bodySmall,
                    ),
                  )
                : RefreshIndicator(
                    onRefresh: _refresh,
                    child: ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      itemCount: messages.length,
                      itemBuilder: (context, i) {
                      final m = messages[i];
                      final mine = m.sender == comms.sender;
                      return Align(
                        alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                          constraints: const BoxConstraints(maxWidth: 320),
                          decoration: BoxDecoration(
                            color: mine ? theme.colorScheme.primaryContainer : theme.colorScheme.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(m.text, style: theme.textTheme.bodyMedium),
                              const SizedBox(height: 2),
                              Text(
                                '${_time(m.created)}${mine ? (m.unread ? ' · sent' : ' · read') : ''}',
                                style: theme.textTheme.labelSmall,
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                    ),
                  ),
          );

          final composer = Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _composer,
                  decoration: InputDecoration(
                    hintText: comms.sender.isEmpty ? 'set a sender identity in settings first' : 'message $_dest…',
                    border: const OutlineInputBorder(),
                    isDense: true,
                  ),
                  minLines: 1,
                  maxLines: 4,
                  onSubmitted: (_) => _send(),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                icon: const Icon(Icons.send),
                tooltip: 'Send',
                onPressed: comms.sender.isEmpty || _dest.isEmpty || comms.busy ? null : _send,
              ),
            ],
          );

          return Column(
            children: [
              Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 8), child: picker),
              if (comms.error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(comms.error!, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
                ),
              thread,
              Padding(padding: const EdgeInsets.all(12), child: composer),
            ],
          );
        },
      ),
    );
  }

  String _time(int seconds) {
    if (seconds == 0) return '';
    final t = DateTime.fromMillisecondsSinceEpoch(seconds * 1000);
    final now = DateTime.now();
    final sameDay = t.year == now.year && t.month == now.month && t.day == now.day;
    final hh = t.hour.toString().padLeft(2, '0');
    final mm = t.minute.toString().padLeft(2, '0');
    return sameDay ? '$hh:$mm' : '${t.month}/${t.day} $hh:$mm';
  }
}
