// chat.dart — the conversation widgets: thread and composer. Extracted
// from the v0 messages screen so the session screen can host them; the
// data plane is CommsController, these stay pure Surface.

import 'package:flutter/material.dart';

import '../state/comms.dart';

/// The message thread for one destination: bubbles with sent/read
/// marks, empty state, pull-to-refresh handled by the host screen.
class ChatThread extends StatelessWidget {
  const ChatThread({
    super.key,
    required this.comms,
    required this.dest,
    this.scrollController,
  });

  final CommsController comms;
  final String dest;
  final ScrollController? scrollController;

  @override
  Widget build(BuildContext context) {
    final messages = dest.isEmpty ? const <CommsMessage>[] : comms.messages(dest);
    final theme = Theme.of(context);

    if (messages.isEmpty) {
      return Center(
        child: Text(
          dest.isEmpty ? 'pick a conversation' : 'no messages yet',
          style: theme.textTheme.bodySmall,
        ),
      );
    }

    return ListView.builder(
      controller: scrollController,
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
              color: mine
                  ? theme.colorScheme.primaryContainer
                  : theme.colorScheme.surfaceContainerHighest,
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

/// The composer: a text field and send button wired to comms.send.
/// Disabled without a sender identity or destination; surfaces the
/// controller error line for the host to show above it.
class ChatComposer extends StatefulWidget {
  const ChatComposer({
    super.key,
    required this.comms,
    required this.dest,
    this.onSent,
  });

  final CommsController comms;
  final String dest;
  final VoidCallback? onSent;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  final _field = TextEditingController();

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _field.text.trim();
    if (text.isEmpty) return;
    _field.clear();
    await widget.comms.send(widget.dest, text);
    widget.onSent?.call();
  }

  @override
  Widget build(BuildContext context) {
    final comms = widget.comms;
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _field,
              decoration: InputDecoration(
                hintText: comms.sender.isEmpty
                    ? 'set a sender identity in settings first'
                    : 'message ${widget.dest}…',
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
            onPressed:
                comms.sender.isEmpty || widget.dest.isEmpty || comms.busy ? null : _send,
          ),
        ],
      ),
    );
  }
}
