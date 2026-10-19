// doc_sync.dart — the pull→apply→persist loop for one stream, over FFI.
//
// This is the App state plane's sync controller taking real shape
// (research/flutter-client.md): Dart owns HTTP and cursors, Rust owns
// the CRDT. The doc is opaque to everything here — changes come off the
// wire as base64, go into the FFI library, and the saved doc is exactly
// what the desktop replicas hold.
//
// Best-effort by design: when the FFI library isn't available (host
// tests, desktop dev without a build), sync() records the failure and
// leaves the rest of the app working.

import 'dart:io';

import '../api/hub_client.dart';
import '../ffi/gz_doc.dart';

class DocSyncResult {
  DocSyncResult({this.applied = 0, this.heads = 0, this.lastSeq = 0, this.docJson, this.error});
  final int applied;
  final int heads;
  final int lastSeq;

  /// The whole doc as JSON (gz_doc_json), captured before dispose —
  /// what the projects parser reads. Null when the doc couldn't be
  /// viewed.
  final String? docJson;
  final String? error;

  bool get ok => error == null;
}

class DocSync {
  DocSync({required this.stream, required this.client, required this.storeDir});

  final String stream;
  final HubClient client;
  final Directory storeDir;

  int? appliedTotal;
  int? headsCount;
  int? lastSeq;
  String? docJson;
  String? error;

  Future<DocSyncResult> sync() async {
    try {
      return await _sync();
    } catch (e) {
      error = e.toString();
      return DocSyncResult(error: error);
    }
  }

  Future<DocSyncResult> _sync() async {
    final docFile = File('${storeDir.path}/$stream.doc');
    final cursorFile = File('${storeDir.path}/$stream.cursor');

    GzDoc doc;
    var since = 0;
    var priorApplied = 0;
    if (docFile.existsSync()) {
      try {
        doc = GzDoc.open(docFile.readAsBytesSync());
        since = int.tryParse(cursorFile.readAsStringSync().trim()) ?? 0;
        priorApplied = int.tryParse(
              File('${storeDir.path}/$stream.applied').readAsStringSync().trim(),
            ) ??
            0;
      } catch (_) {
        // corrupt local state: start over from seq 0
        doc = GzDoc.empty();
        since = 0;
        priorApplied = 0;
      }
    } else {
      doc = GzDoc.empty();
    }

    var applied = 0;
    var last = since;
    while (true) {
      final page = await client.changes(stream, since);
      final blobs = [for (final b64 in page.changes) b64decode(b64)];
      if (blobs.isNotEmpty) {
        doc.applyBatch(blobs);
        applied += blobs.length;
      }
      if (page.next == null) {
        last = page.lastSeq;
        break;
      }
      since = page.next!;
    }

    if (applied > 0 || !docFile.existsSync()) {
      await docFile.writeAsBytes(doc.save(), flush: true);
      await cursorFile.writeAsString('$last', flush: true);
      await File('${storeDir.path}/$stream.applied')
          .writeAsString('${priorApplied + applied}', flush: true);
    }
    final heads = doc.heads().length;
    String? docJson;
    try {
      docJson = doc.json();
    } catch (_) {
      // a JSON view failure shouldn't fail the sync that just worked
    }
    doc.dispose();

    appliedTotal = priorApplied + applied;
    headsCount = heads;
    lastSeq = last;
    this.docJson = docJson;
    error = null;
    return DocSyncResult(applied: applied, heads: heads, lastSeq: last, docJson: docJson);
  }

  /// One-line status for the sync card, null before the first sync.
  String? get statusLine {
    if (error != null) return 'doc: $error';
    if (lastSeq == null) return null;
    return 'doc: $appliedTotal changes · $headsCount heads · seq $lastSeq';
  }
}
