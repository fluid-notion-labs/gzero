// FFI round-trip against the host-built libgzero_ffi.so. Skips when the
// library hasn't been built (cargo build --release in gzero-ffi).
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:gzero_client/ffi/gz_doc.dart';

String get libPath {
  const candidates = [
    '../gzero-ffi/target/release/libgzero_ffi.so',
    'gzero-ffi/target/release/libgzero_ffi.so',
  ];
  for (final c in candidates) {
    if (File(c).existsSync()) return c;
  }
  return '';
}

void main() {
  final lib = libPath;
  if (lib.isEmpty) {
    test('gz_doc: library not built — skipping', () {}, skip: 'build gzero-ffi first');
  } else {
    setUpAll(() => gzeroFfiLibPath = lib);
  }

  test('open/save round-trip preserves the doc', () {
    final fixture = File('test/gz_fixture.bin').readAsBytesSync();
    final doc = GzDoc.open(fixture);
    final saved = doc.save();
    expect(saved, equals(fixture));
    doc.dispose();
  });

  test('apply increments heads; convergence kills the diff', () {
    final fixture = File('test/gz_fixture.bin').readAsBytesSync();
    final doc = GzDoc.open(fixture);
    expect(doc.heads().length, 1);

    // a peer with nothing gets the change
    final batch = doc.changesSince([]);
    expect(batch.length, 1);

    // the same doc again: nothing new for a peer with the head
    final again = doc.changesSince(doc.heads());
    expect(again, isEmpty);

    // a fresh doc applies the batch and converges
    final fresh = GzDoc.empty();
    expect(fresh.heads(), isEmpty);
    expect(fresh.applyBatch(batch), 1);
    expect(fresh.heads().length, 1);
    final head0 = doc.heads()[0];
    final head1 = fresh.heads()[0];
    expect(head1, equals(head0));
    expect(fresh.changesSince([head0]), isEmpty);

    fresh.dispose();
    doc.dispose();
  });

  test('corrupt input is rejected, not crashed', () {
    final doc = GzDoc.empty();
    expect(
      () => doc.applyBatch([Uint8List.fromList([1, 2, 3])]), // truncated blob
      throwsA(isA<FormatException>()),
    );
    expect(() => GzDoc.open(Uint8List.fromList('not a doc'.codeUnits)),
        throwsA(isA<FormatException>()));
    doc.dispose();
  });

  test('json view exposes the items/projects schema', () {
    final fixture = File('test/gz_projects.bin').readAsBytesSync();
    final doc = GzDoc.open(fixture);
    final root = jsonDecode(doc.json()) as Map<String, dynamic>;
    final items = root['items'] as Map<String, dynamic>;
    final tablet = items['project/tablet'] as Map<String, dynamic>;
    final item = tablet['itm_1'] as Map<String, dynamic>;
    expect(item['title'], 'wire up projects');
    expect(item['status'], 'in_progress');
    expect(item['priority'], 5);
    expect((items['comms'] as Map).isEmpty, isTrue);
    expect(root['hello'], 'world');
    doc.dispose();
  });

  test('batch framing round-trips', () {
    final blobs = [Uint8List.fromList([1, 2]), Uint8List.fromList([3]), Uint8List(0)];
    final decoded = decodeBatch(encodeBatch(blobs));
    expect(decoded.length, 3);
    expect(decoded[0], [1, 2]);
    expect(decoded[1], [3]);
    expect(decoded[2], isEmpty);
  });

  test('applyBatchHashes reports the applied changes\' hashes', () {
    final a = GzDoc.empty();
    final c = GzDoc.empty();
    a.commsSend(dest: 'x', sender: 's', text: 'trigger a change');
    final outgoing = a.changesSince(const []);
    expect(outgoing, isNotEmpty);

    final hashes = c.applyBatchHashes(outgoing);
    expect(hashes, hasLength(outgoing.length));
    expect(c.heads(), a.heads(), reason: 'applied changes converge to the same heads');
    // feeding those hashes back as "have": nothing left to send
    expect(c.changesSince(hashes), isEmpty);
    a.dispose();
    c.dispose();
  });

  test('commsSend writes the message schema; commsMarkRead stamps reads', () {
    final doc = GzDoc.empty();
    final m1 = doc.commsSend(dest: 'agent-1', sender: 'tablet-x', text: 'hello');
    expect(m1['dest'], 'agent-1');
    expect(m1['text'], 'hello');
    expect(m1['read_at'], 0);
    final m2 = doc.commsSend(dest: 'agent-1', sender: 'tablet-x', text: 'again');
    expect(m2['id'], isNot(m1['id']), reason: 'ids must not collide');
    expect(() => doc.commsSend(dest: '', sender: 's', text: 'x'), throwsArgumentError);

    final view = jsonDecode(doc.json()) as Map<String, dynamic>;
    expect((view['messages'] as Map).length, 2);

    expect(doc.commsMarkRead(dest: 'agent-1'), 2);
    expect(doc.commsMarkRead(dest: 'agent-1'), 0, reason: 'second pass is a no-op');
    final view2 = jsonDecode(doc.json()) as Map<String, dynamic>;
    final reads = view2['reads'] as Map;
    expect(reads.length, 2);
    expect((reads[m1['id']] as num).toInt(), greaterThan(0));
    doc.dispose();
  });
}
