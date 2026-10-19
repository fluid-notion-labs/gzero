// gz_doc.dart — dart:ffi bindings for libgzero_ffi (gzero-ffi crate).
//
// The library owns the CRDT; Dart treats automerge bytes as opaque.
// Batch protocol (both directions): u32 LE length + bytes, repeated.
// Callers must dispose() — every open/save/changes call returns memory
// owned by Rust until freed with gz_buf_free.

import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

DynamicLibrary _open() {
  if (gzeroFfiLibPath != null) return DynamicLibrary.open(gzeroFfiLibPath!);
  if (Platform.isAndroid) return DynamicLibrary.open('libgzero_ffi.so');
  final env = Platform.environment['GZERO_FFI_LIB'];
  if (env != null && env.isNotEmpty) return DynamicLibrary.open(env);
  return DynamicLibrary.open('libgzero_ffi.so');
}

/// Explicit library path override (tests/dev); checked before the defaults.
String? gzeroFfiLibPath;

final DynamicLibrary _lib = _open();

final Pointer<Void> Function(Pointer<Uint8>, int) _docOpen = _lib
    .lookup<NativeFunction<Pointer<Void> Function(Pointer<Uint8>, IntPtr)>>('gz_doc_open')
    .asFunction();

final Pointer<Void> Function() _docNew = _lib
    .lookup<NativeFunction<Pointer<Void> Function()>>('gz_doc_new')
    .asFunction();

final void Function(Pointer<Void>) _docFree = _lib
    .lookup<NativeFunction<Void Function(Pointer<Void>)>>('gz_doc_free')
    .asFunction();

final Pointer<Uint8> Function(Pointer<Void>, Pointer<IntPtr>) _docSave = _lib
    .lookup<NativeFunction<Pointer<Uint8> Function(Pointer<Void>, Pointer<IntPtr>)>>('gz_doc_save')
    .asFunction();

final int Function(Pointer<Void>, Pointer<Uint8>, int) _docApply = _lib
    .lookup<NativeFunction<Int32 Function(Pointer<Void>, Pointer<Uint8>, IntPtr)>>('gz_doc_apply')
    .asFunction();

final Pointer<Uint8> Function(Pointer<Void>, Pointer<Uint8>, int, Pointer<IntPtr>)
    _docChangesSince = _lib
        .lookup<
            NativeFunction<
                Pointer<Uint8> Function(
                    Pointer<Void>, Pointer<Uint8>, IntPtr, Pointer<IntPtr>)>>('gz_doc_changes_since')
        .asFunction();

final Pointer<Uint8> Function(Pointer<Void>, Pointer<IntPtr>) _docHeads = _lib
    .lookup<NativeFunction<Pointer<Uint8> Function(Pointer<Void>, Pointer<IntPtr>)>>('gz_doc_heads')
    .asFunction();

final Pointer<Uint8> Function(Pointer<Void>, Pointer<IntPtr>) _docJson = _lib
    .lookup<NativeFunction<Pointer<Uint8> Function(Pointer<Void>, Pointer<IntPtr>)>>('gz_doc_json')
    .asFunction();

final void Function(Pointer<Uint8>, int) _bufFree = _lib
    .lookup<NativeFunction<Void Function(Pointer<Uint8>, IntPtr)>>('gz_buf_free')
    .asFunction();

/// Framing: [u32 LE length][bytes], repeated.
Uint8List encodeBatch(List<Uint8List> blobs) {
  final out = BytesBuilder();
  final len = Uint8List(4)..buffer.asByteData().setUint32(0, 0, Endian.little);
  for (final blob in blobs) {
    len.buffer.asByteData().setUint32(0, blob.length, Endian.little);
    out.add(len);
    out.add(blob);
  }
  return out.toBytes();
}

List<Uint8List> decodeBatch(Uint8List batch) {
  final out = <Uint8List>[];
  var i = 0;
  while (i < batch.length) {
    if (i + 4 > batch.length) throw const FormatException('batch: truncated length header');
    final len = batch.buffer.asByteData(batch.offsetInBytes + i, 4).getUint32(0, Endian.little);
    i += 4;
    if (i + len > batch.length) throw const FormatException('batch: truncated blob');
    out.add(Uint8List.sublistView(batch, i, i + len));
    i += len;
  }
  return out;
}

/// A live automerge document in the FFI library. Not copyable; call
/// [dispose] exactly once.
class GzDoc {
  GzDoc._(this._ptr);

  Pointer<Void>? _ptr;

  factory GzDoc.open(Uint8List bytes) {
    final buf = bytes.isEmpty ? nullptr : calloc<Uint8>(bytes.length);
    if (bytes.isNotEmpty) buf.cast<Uint8>().asTypedList(bytes.length).setAll(0, bytes);
    final ptr = _docOpen(buf.cast<Uint8>(), bytes.length);
    if (buf != nullptr) calloc.free(buf);
    if (ptr == Pointer.fromAddress(0)) {
      throw const FormatException('gz_doc_open: not a valid document');
    }
    return GzDoc._(ptr);
  }

  factory GzDoc.empty() => GzDoc._(_docNew());

  bool get isDisposed => _ptr == null;

  /// Serialize the full document (save format).
  Uint8List save() {
    final ptr = _require();
    final outLen = calloc<IntPtr>();
    final data = _docSave(ptr, outLen);
    final len = outLen.value;
    calloc.free(outLen);
    if (data == Pointer.fromAddress(0)) {
      throw StateError('gz_doc_save failed');
    }
    final bytes = Uint8List.fromList(data.asTypedList(len));
    _bufFree(data, len);
    return bytes;
  }


  /// Full document as JSON text (automerge's JSON form: maps, lists,
  /// strings, numbers).
  String json() {
    final ptr = _require();
    final outLen = calloc<IntPtr>();
    final data = _docJson(ptr, outLen);
    final len = outLen.value;
    calloc.free(outLen);
    if (data == Pointer.fromAddress(0)) {
      throw StateError('gz_doc_json failed');
    }
    final bytes = Uint8List.fromList(data.asTypedList(len));
    _bufFree(data, len);
    return utf8.decode(bytes);
  }

  /// Apply a batch of raw changes; returns the number applied.
  int applyBatch(List<Uint8List> changes) {
    final ptr = _require();
    final batch = encodeBatch(changes);
    final buf = calloc<Uint8>(batch.length);
    buf.asTypedList(batch.length).setAll(0, batch);
    final n = _docApply(ptr, buf, batch.length);
    calloc.free(buf);
    if (n < 0) throw const FormatException('gz_doc_apply: rejected batch');
    return n;
  }

  /// Changes this doc has that a peer with [have] (32-byte hashes) hasn't.
  List<Uint8List> changesSince(List<Uint8List> have) {
    final ptr = _require();
    final haveBytes = Uint8List.fromList(have.expand((h) => h).toList());
    final buf = haveBytes.isEmpty ? nullptr : calloc<Uint8>(haveBytes.length);
    if (haveBytes.isNotEmpty) {
      buf.cast<Uint8>().asTypedList(haveBytes.length).setAll(0, haveBytes);
    }
    final outLen = calloc<IntPtr>();
    final data = _docChangesSince(ptr, buf.cast<Uint8>(), have.length, outLen);
    if (buf != nullptr) calloc.free(buf);
    final len = outLen.value;
    calloc.free(outLen);
    if (data == Pointer.fromAddress(0)) {
      if (len != 0) throw StateError('gz_doc_changes_since failed');
      return const [];
    }
    final batch = Uint8List.fromList(data.asTypedList(len));
    _bufFree(data, len);
    return decodeBatch(batch);
  }

  /// The doc's head hashes (32 bytes each).
  List<Uint8List> heads() {
    final ptr = _require();
    final outCount = calloc<IntPtr>();
    final data = _docHeads(ptr, outCount);
    final count = outCount.value;
    calloc.free(outCount);
    if (data == Pointer.fromAddress(0)) {
      if (count != 0) throw StateError('gz_doc_heads failed');
      return const [];
    }
    final bytes = Uint8List.fromList(data.asTypedList(count * 32));
    _bufFree(data, count * 32);
    return [for (var i = 0; i < count; i++) Uint8List.sublistView(bytes, i * 32, (i + 1) * 32)];
  }

  Pointer<Void> _require() {
    final p = _ptr;
    if (p == null) throw StateError('GzDoc disposed');
    return p;
  }

  void dispose() {
    final p = _ptr;
    if (p == null) return;
    _ptr = null;
    _docFree(p);
  }
}

// base64 helpers for the hub wire format (changes ride as base64 in JSON)
Uint8List b64decode(String s) => base64Decode(s);
String b64encode(List<int> bytes) => base64Encode(bytes);
