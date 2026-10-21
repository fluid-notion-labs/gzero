// dump_comms_test.dart — manual diagnostics: pull the comms bag from seq
// 0 exactly like the tablet does and print the sessions/messages the
// device would see. Runs only when DUMP_COMMS=1 with CX_TOKEN in env.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:gzero_client/api/hub_client.dart';
import 'package:gzero_client/ffi/gz_doc.dart';

void main() {
  final dump = Platform.environment['DUMP_COMMS'] == '1';
  final token = Platform.environment['CX_TOKEN'] ?? '';
  final hubUrl = Platform.environment['CX_HUB_URL'] ?? 'https://gzero-hub.nick-hems.workers.dev';
  test('dump comms bag', () async {
    if (!dump) return;
    final client = HubClient(baseUrl: hubUrl, token: token);
    final doc = GzDoc.empty();
    final sinceStart = int.parse(Platform.environment['DUMP_FROM'] ?? '0');
    var since = sinceStart;
    var applied = 0;
    while (true) {
      final page = await client.changes('comms', since);
      final blobs = [for (final b64 in page.changes) b64decode(b64)];
      if (blobs.isNotEmpty) {
        doc.applyBatch(blobs);
        applied += blobs.length;
      }
      if (page.next == null) break;
      since = page.next!;
    }
    final view = jsonDecode(doc.json()) as Map<String, dynamic>;
    stdout.writeln('root keys: ${view.keys.toList()}');
    final sessions = (view['sessions'] as Map?) ?? {};
    final messages = (view['messages'] as Map?) ?? {};
    final reads = (view['reads'] as Map?) ?? {};
    stdout.writeln('applied: $applied (from seq $sinceStart, last_seq $since)');
    final epoch = view['epoch'] as Map?;
    stdout.writeln('epoch: $epoch');
    stdout.writeln('sessions (${sessions.length}):');
    for (final e in sessions.entries) {
      final v = e.value as Map;
      stdout.writeln('  ${e.key}: machine=${v['machine']} scope=${v['scope']} cwd=${v['cwd']} pid=${v['pid']} label=${v['label']} last_seen=${v['last_seen']}');
    }
    stdout.writeln('messages (${messages.length}):');
    for (final e in messages.entries) {
      final v = e.value as Map;
      stdout.writeln('  ${e.key}: to=${v['dest']} from=${v['sender']} read=${reads[e.key] != null} "${(v['text'] as String?) ?? ''}"');
    }
    doc.dispose();
  }, skip: !dump);
}
