// sync_controller.dart — the App state plane's sync observable (v0).
//
// Not the pull→merge→push loop yet: for now it polls each stream's head
// seq through the hub client and surfaces per-stream status. It is the
// sync status card's data source and the honest skeleton the real
// controller (offline queue, cursors, automerge) grows into.

import 'dart:io';

import 'package:flutter/foundation.dart';

import '../api/hub_client.dart';
import 'doc_sync.dart';
import 'projects.dart';

/// The streams the client watches. `context` and `comms` are the two
/// system streams; project streams (`project/<scope>`) join when the
/// projects list lands.
const List<String> systemStreams = ['context', 'comms'];

class StreamStatus {
  StreamStatus(this.name, {this.lastSeq, this.error});
  final String name;
  final int? lastSeq;
  final String? error;

  bool get ok => error == null && lastSeq != null;
}

class SyncController extends ChangeNotifier {
  SyncController(this._client, {this.streams = systemStreams, Directory? docStoreDir})
      : commsDoc = docStoreDir == null ? null : DocSync(stream: 'comms', client: _client, storeDir: docStoreDir),
        contextDoc = docStoreDir == null ? null : DocSync(stream: 'context', client: _client, storeDir: docStoreDir);

  final HubClient _client;
  final List<String> streams;

  /// The comms doc replica, when the app has a store directory. Null in
  /// tests and desktop dev without a doc store — the rest keeps working.
  final DocSync? commsDoc;

  /// The context doc replica — the projects data plane reads its JSON
  /// view. Same null rules as [commsDoc].
  final DocSync? contextDoc;

  /// Projects parsed from the context doc's last sync (empty before the
  /// first successful context sync).
  List<Project> get projects => parseProjects(contextDoc?.docJson);

  List<StreamStatus> statuses = [];
  DateTime? lastChecked;
  String? connectionError;
  bool busy = false;

  bool get healthy => connectionError == null && statuses.isNotEmpty && statuses.every((s) => s.ok);

  Future<void> refresh() async {
    busy = true;
    connectionError = null;
    notifyListeners();
    try {
      await _client.health();
    } catch (e) {
      connectionError = e.toString();
      busy = false;
      notifyListeners();
      return;
    }
    final next = <StreamStatus>[];
    for (final stream in streams) {
      try {
        next.add(StreamStatus(stream, lastSeq: await _client.headSeq(stream)));
      } catch (e) {
        next.add(StreamStatus(stream, error: e.toString()));
      }
    }
    statuses = next;
    lastChecked = DateTime.now();
    // the doc replicas ride the same refresh; failures are surfaced on
    // their own lines, never blocking the card
    await commsDoc?.sync();
    await contextDoc?.sync();
    busy = false;
    notifyListeners();
  }
}
