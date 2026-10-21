// comms.dart — the messaging data plane: pull + push of the comms
// document, message reads, sending, read receipts.
//
// Companion to doc_sync.dart, which is pull-only. The comms stream is
// bidirectional: the tablet both reads what agents sent and writes
// messages back, so the controller owns a push cursor (the heads the
// hub has already accepted, persisted beside the doc) as well as the
// pull cursor. Same file names as DocSync (comms.doc, comms.cursor) so
// a device that synced with the pull-only controller keeps its state;
// comms.heads is new.
//
// Rust owns the CRDT (gzero-ffi); Dart owns HTTP, cursors and the
// offline queue. Messages sent while offline queue in the local doc and
// are pushed on the next successful sync.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../api/hub_client.dart';
import '../ffi/gz_doc.dart';
import 'doc_sync.dart';

/// How long messages stay visible (mirrors the main crate's
/// MESSAGE_TTL_SECS — expiry is client-side filtering).
const Duration messageTtl = Duration(days: 7);

/// How fresh a session's heartbeat must be to count as active (mirrors
/// PRESENCE_TTL_SECS).
const Duration presenceTtl = Duration(minutes: 5);

/// One message in a conversation.
class CommsMessage {
  CommsMessage({required this.id, required this.dest, required this.sender, required this.text, required this.created, required this.readAt});

  final String id;
  final String dest;
  final String sender;
  final String text;
  final int created;
  final int readAt;

  bool get unread => readAt == 0;

  factory CommsMessage.fromJson(String id, Map<String, dynamic> doc, Map<String, dynamic> reads) {
    return CommsMessage(
      id: id,
      dest: (doc['dest'] as String?) ?? '',
      sender: (doc['sender'] as String?) ?? '',
      text: (doc['text'] as String?) ?? '',
      created: (doc['created'] as num?)?.toInt() ?? 0,
      readAt: (reads[id] as num?)?.toInt() ?? 0,
    );
  }
}

/// A session (presence) — the shell's agent rows and the chat
/// destination.
class CommsSession {
  CommsSession({required this.id, required this.machine, required this.scope, required this.label, required this.cwd, required this.startedAt, required this.lastSeen});
  final String id;
  final String machine;
  final String scope;
  final String label;
  final String cwd;
  final int startedAt;
  final int lastSeen;

  String get title => label.isNotEmpty ? '$label ($machine)' : '$machine · ${scope.split('/').last}';
}

/// Result of one comms sync.
class CommsSyncResult {
  CommsSyncResult({this.pushed = 0, this.applied = 0, this.lastSeq = 0, this.docJson, this.error});

  final int pushed;
  final int applied;
  final int lastSeq;
  final String? docJson;
  final String? error;

  bool get ok => error == null;
}

/// The comms document's sync controller: pull what the hub has, push
/// what the hub doesn't, and expose the parsed views the UI needs.
class CommsController extends ChangeNotifier implements DocSyncLike {
  CommsController({required this.client, required this.storeDir, this.sender = '', this.stream = 'comms'});

  final HubClient client;

  /// Where comms.doc lives; null in tests/desktop dev without a store —
  /// reads keep working, sync and send report the missing store.
  final Directory? storeDir;
  final String stream;

  /// This device's identity on outgoing messages. Empty = cannot send.
  String sender;

  String? docJson;
  String? error;
  bool busy = false;
  DateTime? lastSync;

  int? _lastSeq;
  List<String> _pushedHeads = []; // hex-encoded ChangeHashes known to be on the hub

  File? get _docFile => storeDir == null ? null : File('${storeDir!.path}/comms.doc');
  File? get _cursorFile => storeDir == null ? null : File('${storeDir!.path}/comms.cursor');
  File? get _headsFile => storeDir == null ? null : File('${storeDir!.path}/comms.heads');

  @override
  String? get statusLine {
    if (error != null) return 'comms: $error';
    if (_lastSeq == null) return null;
    return 'comms: synced · seq $_lastSeq';
  }

  /// One sync: pull the hub's changes, then push anything local the hub
  /// hasn't seen. Best-effort — failures are recorded, not thrown.
  @override
  Future<DocSyncResult> sync() async {
    busy = true;
    notifyListeners();
    final result = await _sync();
    busy = false;
    lastSync = DateTime.now();
    error = result.error;
    notifyListeners();
    return result;
  }

  Future<DocSyncResult> _sync() async {
    final docFile = _docFile;
    final cursorFile = _cursorFile;
    final headsFile = _headsFile;
    if (docFile == null || cursorFile == null || headsFile == null) {
      return DocSyncResult(error: 'no doc store');
    }
    final storeDir = this.storeDir!;

    GzDoc doc;
    var since = 0;
    var priorApplied = 0;
    if (docFile.existsSync()) {
      try {
        doc = GzDoc.open(docFile.readAsBytesSync());
        since = int.tryParse(cursorFile.readAsStringSync().trim()) ?? 0;
        priorApplied = int.tryParse(File('${storeDir.path}/comms.applied').readAsStringSync().trim()) ?? 0;
        _pushedHeads = _loadHeads(headsFile, doc);
      } catch (_) {
        doc = GzDoc.empty();
        since = 0;
        priorApplied = 0;
        _pushedHeads = [];
      }
    } else {
      doc = GzDoc.empty();
      _pushedHeads = [];
    }

    var applied = 0;
    var last = since;
    try {
      // Pull: everything after our cursor, applying and recording each
      // change's hash as "known to the hub" (the hub does not dedupe).
      while (true) {
        final page = await client.changes(stream, since);
        final blobs = [for (final b64 in page.changes) b64decode(b64)];
        if (blobs.isNotEmpty) {
          _pushedHeads.addAll([for (final h in doc.applyBatchHashes(blobs)) hex(h)]);
          applied += blobs.length;
        }
        if (page.next == null) {
          last = page.lastSeq;
          break;
        }
        since = page.next!;
      }

      // Push: whatever the doc still has that the hub hasn't accepted.
      var pushed = 0;
      final outgoing = doc.changesSince([for (final h in _pushedHeads) Uint8List.fromList(unhex(h))]);
      if (outgoing.isNotEmpty) {
        await client.push(stream, [for (final c in outgoing) b64encode(c)]);
        pushed = outgoing.length;
        _pushedHeads = [for (final h in doc.heads()) hex(h)];
      }

      if (applied > 0 || pushed > 0 || !docFile.existsSync()) {
        await docFile.writeAsBytes(doc.save(), flush: true);
        await cursorFile.writeAsString('$last', flush: true);
        await headsFile.writeAsString(jsonEncode(_pushedHeads), flush: true);
        await File('${storeDir.path}/comms.applied').writeAsString('${priorApplied + applied}', flush: true);
      }
      _lastSeq = last;
      int heads = 0;
      try {
        heads = doc.heads().length;
        docJson = doc.json();
      } catch (_) {
        // a JSON view failure shouldn't fail the sync that just worked
      }
      doc.dispose();
      notifyListeners();
      return DocSyncResult(applied: priorApplied + applied, heads: heads, lastSeq: last, docJson: docJson);
    } catch (e) {
      doc.dispose();
      return DocSyncResult(error: e.toString());
    }
  }

  /// Send a message to [dest]. Requires a sender identity. The message
  /// is written into the local doc immediately (offline-safe) and rides
  /// the next sync's push.
  Future<CommsMessage?> send(String dest, String text) async {
    final docFile = _docFile;
    if (docFile == null || sender.isEmpty || text.trim().isEmpty || dest.trim().isEmpty) return null;
    CommsMessage? message;
    final doc = _openLocal(docFile);
    try {
      final json = doc.commsSend(dest: dest.trim(), sender: sender, text: text.trim());
      message = CommsMessage.fromJson(json['id'] as String, json, const {});
      await docFile.writeAsBytes(doc.save(), flush: true);
    } finally {
      doc.dispose();
    }
    await sync();
    return message;
  }

  /// Mark everything to [dest] read in the local doc, then sync (pushes
  /// the read receipts).
  Future<int> markRead(String dest) async {
    final docFile = _docFile;
    if (docFile == null) return 0;
    var marked = 0;
    final doc = _openLocal(docFile);
    try {
      marked = doc.commsMarkRead(dest: dest);
      if (marked > 0) await docFile.writeAsBytes(doc.save(), flush: true);
    } finally {
      doc.dispose();
    }
    if (marked > 0) await sync();
    return marked;
  }

  /// The conversation with [dest]: messages addressed to it (or from it
  /// to us), oldest first, expired ones filtered out.
  List<CommsMessage> messages(String dest) {
    final doc = _parsed();
    if (doc == null) return const [];
    final messages = doc['messages'];
    final reads = (doc['reads'] as Map?) ?? const {};
    if (messages is! Map) return const [];
    final cutoff = DateTime.now().millisecondsSinceEpoch ~/ 1000 - messageTtl.inSeconds;
    final out = <CommsMessage>[];
    messages.forEach((id, value) {
      if (value is! Map) return;
      final m = CommsMessage.fromJson(id as String, Map<String, dynamic>.from(value), Map<String, dynamic>.from(reads));
      if (m.dest != dest) return;
      if (m.created < cutoff) return;
      out.add(m);
    });
    out.sort((a, b) => a.created.compareTo(b.created));
    return out;
  }

  /// Sessions with a heartbeat newer than [within], newest first.
  /// The shell passes a longer window to show recent (not just alive)
  /// agents; [sessions] stays the alive-only shorthand.
  List<CommsSession> sessions({Duration within = presenceTtl}) {
    final doc = _parsed();
    if (doc == null) return const [];
    final sessions = doc['sessions'];
    if (sessions is! Map) return const [];
    final cutoff = DateTime.now().millisecondsSinceEpoch ~/ 1000 - within.inSeconds;
    final out = <CommsSession>[];
    sessions.forEach((id, value) {
      if (value is! Map) return;
      final lastSeen = (value['last_seen'] as num?)?.toInt() ?? 0;
      if (lastSeen < cutoff) return;
      out.add(CommsSession(
        id: id as String,
        machine: (value['machine'] as String?) ?? '',
        scope: (value['scope'] as String?) ?? '',
        label: (value['label'] as String?) ?? '',
        cwd: (value['cwd'] as String?) ?? '',
        startedAt: (value['started_at'] as num?)?.toInt() ?? 0,
        lastSeen: lastSeen,
      ));
    });
    out.sort((a, b) => b.lastSeen.compareTo(a.lastSeen));
    return out;
  }

  /// Unread messages addressed to [sessionId] — the count the shell's
  /// badges show.
  int unreadFor(String sessionId) {
    var count = 0;
    for (final m in messages(sessionId)) {
      if (m.unread) count++;
    }
    return count;
  }

  Map<String, dynamic>? _parsed() {
    final json = docJson;
    if (json == null) return null;
    try {
      return jsonDecode(json) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  GzDoc _openLocal(File docFile) {
    if (docFile.existsSync()) {
      try {
        return GzDoc.open(docFile.readAsBytesSync());
      } catch (_) {
        return GzDoc.empty();
      }
    }
    return GzDoc.empty();
  }

  /// Heads the hub has accepted. Before the first push, a doc that only
  /// ever pulled counts as fully synced (the tablet never wrote before
  /// this controller existed).
  List<String> _loadHeads(File headsFile, GzDoc doc) {
    if (headsFile.existsSync()) {
      try {
        final decoded = jsonDecode(headsFile.readAsStringSync());
        if (decoded is List) return [for (final h in decoded) h as String];
      } catch (_) {}
    }
    return [for (final h in doc.heads()) hex(h)];
  }
}

String hex(List<int> bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

List<int> unhex(String s) => [for (var i = 0; i + 1 < s.length; i += 2) int.parse(s.substring(i, i + 2), radix: 16)];
