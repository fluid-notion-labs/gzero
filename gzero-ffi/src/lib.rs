//! gzero-ffi — the automerge surface for the Flutter client.
//!
//! The phone's sync loop (Dart) owns HTTP, cursors, and the offline
//! queue; this library owns the CRDT. Bytes cross the boundary as
//! automerge's native change/doc blobs — the same bytes the hub
//! transports, so Dart treats them as opaque and no format is invented.
//!
//! Batch protocol: a batch of binary blobs is `u32 LE length` + bytes,
//! repeated. Used for applying changes (in) and fetching changes (out);
//! heads use the same framing with fixed 32-byte hashes.

use automerge::transaction::Transactable;
use automerge::{AutoCommit, Change, ChangeHash, ObjId, ObjType, Prop, ReadDoc, Value, ROOT};
use serde_json::Value as Json;
use std::slice;

pub struct GzDoc {
    doc: AutoCommit,
}

/// The change-batch framing error, shared by parse functions.
fn parse_batch(bytes: &[u8]) -> Result<Vec<&[u8]>, String> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if i + 4 > bytes.len() {
            return Err("batch: truncated length header".into());
        }
        let len = u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        i += 4;
        if i + len > bytes.len() {
            return Err("batch: truncated blob".into());
        }
        out.push(&bytes[i..i + len]);
        i += len;
    }
    Ok(out)
}

fn write_batch(items: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for item in items {
        out.extend_from_slice(&(item.len() as u32).to_le_bytes());
        out.extend_from_slice(item);
    }
    out
}

// Test shim: safe wrappers over the unsafe C ABI for test modules —
// test inputs are valid by construction.
#[cfg(test)]
macro_rules! ffi_shims {
    () => {
        fn gz_doc_open(bytes: *const u8, len: usize) -> *mut GzDoc {
            unsafe { super::gz_doc_open(bytes, len) }
        }
        fn gz_doc_free(doc: *mut GzDoc) {
            unsafe { super::gz_doc_free(doc) }
        }
        fn gz_doc_save(doc: *mut GzDoc, out_len: *mut usize) -> *mut u8 {
            unsafe { super::gz_doc_save(doc, out_len) }
        }
        fn gz_doc_apply(doc: *mut GzDoc, bytes: *const u8, len: usize) -> i32 {
            unsafe { super::gz_doc_apply(doc, bytes, len) }
        }
        fn gz_doc_changes_since(
            doc: *mut GzDoc,
            have: *const u8,
            have_count: usize,
            out_len: *mut usize,
        ) -> *mut u8 {
            unsafe { super::gz_doc_changes_since(doc, have, have_count, out_len) }
        }
        fn gz_doc_heads(doc: *mut GzDoc, out_count: *mut usize) -> *mut u8 {
            unsafe { super::gz_doc_heads(doc, out_count) }
        }
        fn gz_doc_json(doc: *mut GzDoc, out_len: *mut usize) -> *mut u8 {
            unsafe { super::gz_doc_json(doc, out_len) }
        }
        fn gz_buf_free(ptr: *mut u8, len: usize) {
            unsafe { super::gz_buf_free(ptr, len) }
        }
        fn gz_comms_send(
            doc: *mut GzDoc,
            dest: *const std::ffi::c_char,
            sender: *const std::ffi::c_char,
            text: *const std::ffi::c_char,
            out_len: *mut usize,
        ) -> *mut u8 {
            unsafe { super::gz_comms_send(doc, dest, sender, text, out_len) }
        }
        fn gz_comms_mark_read(doc: *mut GzDoc, dest: *const std::ffi::c_char, out_len: *mut usize) -> *mut u8 {
            unsafe { super::gz_comms_mark_read(doc, dest, out_len) }
        }
        fn gz_doc_apply_hashes(doc: *mut GzDoc, bytes: *const u8, len: usize, out_len: *mut usize) -> *mut u8 {
            unsafe { super::gz_doc_apply_hashes(doc, bytes, len, out_len) }
        }
    };
}

/// Load a document from `save_bytes` format. Returns null on parse error.
///
/// # Safety
///
/// `bytes` must point to `len` readable bytes, or be null (null returns
/// null). The returned pointer is owned by the caller and freed with
/// `gz_doc_free`.
#[no_mangle]
pub unsafe extern "C" fn gz_doc_open(bytes: *const u8, len: usize) -> *mut GzDoc {
    if bytes.is_null() {
        return std::ptr::null_mut();
    }
    let slice = unsafe { slice::from_raw_parts(bytes, len) };
    match AutoCommit::load(slice) {
        Ok(doc) => Box::into_raw(Box::new(GzDoc { doc })),
        Err(_) => std::ptr::null_mut(),
    }
}

/// A fresh empty document.
#[no_mangle]
pub extern "C" fn gz_doc_new() -> *mut GzDoc {
    Box::into_raw(Box::new(GzDoc {
        doc: AutoCommit::new(),
    }))
}

/// Free a document previously returned by `gz_doc_open`/`gz_doc_new`.
/// Null is a no-op.
///
/// # Safety
///
/// `doc` must have been returned by this API and not freed before, or be
/// null. Freeing a foreign or already-freed pointer is undefined.
#[no_mangle]
pub unsafe extern "C" fn gz_doc_free(doc: *mut GzDoc) {
    if !doc.is_null() {
        unsafe { drop(Box::from_raw(doc)) };
    }
}

/// Serialize the full document (save format). Returns null on failure.
///
/// # Safety
///
/// `doc` must be a valid `GzDoc` pointer from `gz_doc_open`/`gz_doc_new`
/// or null (null returns null); `out_len` must be a valid writable
/// `usize` pointer or null. The returned buffer is owned by the caller
/// and freed with `gz_buf_free`.
#[no_mangle]
pub unsafe extern "C" fn gz_doc_save(doc: *mut GzDoc, out_len: *mut usize) -> *mut u8 {
    if doc.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let doc = unsafe { &mut *doc };
    let bytes = doc.doc.save();
    unsafe { *out_len = bytes.len() };
    Box::into_raw(bytes.into_boxed_slice()) as *mut u8
}

/// Apply a batch of raw changes (length-prefixed). Returns the number
/// applied, or -1 on a parse/apply error.
///
/// # Safety
///
/// `doc` must be a valid `GzDoc` pointer or null (null returns -1);
/// `bytes` must point to `len` readable bytes or be null. The doc is
/// mutated in place.
#[no_mangle]
pub unsafe extern "C" fn gz_doc_apply(doc: *mut GzDoc, bytes: *const u8, len: usize) -> i32 {
    if doc.is_null() || bytes.is_null() {
        return -1;
    }
    let doc = unsafe { &mut *doc };
    let slice = unsafe { slice::from_raw_parts(bytes, len) };
    let blobs = match parse_batch(slice) {
        Ok(b) => b,
        Err(_) => return -1,
    };
    let parsed = blobs
        .iter()
        .map(|b| Change::from_bytes(b.to_vec()))
        .collect::<Result<Vec<_>, _>>();
    let changes = match parsed {
        Ok(c) => c,
        Err(_) => return -1,
    };
    let n = changes.len() as i32;
    if doc.doc.apply_changes(changes).is_err() {
        return -1;
    }
    n
}

/// Changes the doc has that the peer (given `have_count` 32-byte hashes)
/// hasn't. Returns a length-prefixed batch; caller frees with gz_buf_free.
///
/// # Safety
///
/// `doc` must be a valid `GzDoc` pointer or null (null returns null);
/// `have` must point to `have_count * 32` readable bytes or be null;
/// `out_len` must be writable or null. The returned buffer is owned by
/// the caller and freed with `gz_buf_free`.
#[no_mangle]
pub unsafe extern "C" fn gz_doc_changes_since(
    doc: *mut GzDoc,
    have: *const u8,
    have_count: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if doc.is_null() || out_len.is_null() || (have.is_null() && have_count > 0) {
        return std::ptr::null_mut();
    }
    let doc = unsafe { &mut *doc };
    let hashes: Vec<ChangeHash> = if have_count > 0 {
        let slice = unsafe { slice::from_raw_parts(have, have_count * 32) };
        (0..have_count)
            .map(|i| ChangeHash(slice[i * 32..(i + 1) * 32].try_into().unwrap()))
            .collect()
    } else {
        Vec::new()
    };
    let changes: Vec<Vec<u8>> = doc
        .doc
        .get_changes(&hashes)
        .into_iter()
        .map(|ch| ch.raw_bytes().to_vec())
        .collect();
    let batch = write_batch(&changes);
    if batch.is_empty() {
        // empty Box<[u8]> dangles; callers treat null + 0 as "nothing"
        unsafe { *out_len = 0 };
        return std::ptr::null_mut();
    }
    unsafe { *out_len = batch.len() };
    Box::into_raw(batch.into_boxed_slice()) as *mut u8
}

/// Apply a batch of raw changes and return the applied changes' hashes
/// as a batch of 32-byte blobs (u32 LE length framing). The Dart sync
/// controller records these as the push cursor — pulled changes are by
/// definition already on the hub and must never be re-pushed (the hub
/// does not dedupe). Returns null on a parse/apply error.
///
/// # Safety
///
/// `doc` must be a valid `GzDoc` pointer or null (null returns null);
/// `bytes` must point to `len` readable bytes or be null; `out_len` must
/// be writable or null. The returned buffer is owned by the caller and
/// freed with `gz_buf_free`.
#[no_mangle]
pub unsafe extern "C" fn gz_doc_apply_hashes(
    doc: *mut GzDoc,
    bytes: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if doc.is_null() || bytes.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let doc = unsafe { &mut *doc };
    let slice = unsafe { slice::from_raw_parts(bytes, len) };
    let blobs = match parse_batch(slice) {
        Ok(b) => b,
        Err(_) => return std::ptr::null_mut(),
    };
    let changes = match blobs
        .iter()
        .map(|b| Change::from_bytes(b.to_vec()))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(c) => c,
        Err(_) => return std::ptr::null_mut(),
    };
    let hashes: Vec<u8> = changes
        .iter()
        .flat_map(|c| c.hash().as_ref().to_vec())
        .collect();
    if doc.doc.apply_changes(changes).is_err() {
        return std::ptr::null_mut();
    }
    if hashes.is_empty() {
        unsafe { *out_len = 0 };
        return std::ptr::null_mut();
    }
    unsafe { *out_len = hashes.len() };
    Box::into_raw(hashes.into_boxed_slice()) as *mut u8
}

/// The doc's head hashes, `count` * 32 bytes. Caller frees.
///
/// # Safety
///
/// `doc` must be a valid `GzDoc` pointer or null (null returns null);
/// `out_count` must be writable or null. The returned buffer is owned by
/// the caller and freed with `gz_buf_free`.
#[no_mangle]
pub unsafe extern "C" fn gz_doc_heads(doc: *mut GzDoc, out_count: *mut usize) -> *mut u8 {
    if doc.is_null() || out_count.is_null() {
        return std::ptr::null_mut();
    }
    let doc = unsafe { &mut *doc };
    let heads: Vec<u8> = doc
        .doc
        .get_heads()
        .iter()
        .flat_map(|h| h.as_ref().to_vec())
        .collect();
    if heads.is_empty() {
        unsafe { *out_count = 0 };
        return std::ptr::null_mut();
    }
    unsafe { *out_count = heads.len() / 32 };
    Box::into_raw(heads.into_boxed_slice()) as *mut u8
}

/// A generic JSON view of the whole document: maps → objects, lists →
/// arrays, text objects → strings, scalars → JSON scalars (the winning
/// value per key). Lets the client read any doc schema without new FFI
/// per feature. Returns a UTF-8 buffer; caller frees.
///
/// # Safety
///
/// `doc` must be a valid `GzDoc` pointer or null (null returns null);
/// `out_len` must be writable or null. The returned UTF-8 buffer is owned
/// by the caller and freed with `gz_buf_free` (NUL-terminated length is
/// the out_len value, not a C string terminator).
#[no_mangle]
pub unsafe extern "C" fn gz_doc_json(doc: *mut GzDoc, out_len: *mut usize) -> *mut u8 {
    if doc.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let doc = unsafe { &mut *doc };
    let json = obj_to_json(&doc.doc, &ROOT, ObjType::Map).to_string();
    let bytes = json.into_bytes();
    if bytes.is_empty() {
        unsafe { *out_len = 0 };
        return std::ptr::null_mut();
    }
    unsafe { *out_len = bytes.len() };
    Box::into_raw(bytes.into_boxed_slice()) as *mut u8
}

fn obj_to_json(doc: &AutoCommit, obj: &ObjId, ty: ObjType) -> Json {
    match ty {
        ObjType::Map => {
            let mut map = serde_json::Map::new();
            for key in doc.keys(obj) {
                if let Some(json) = get_json(doc, obj, key.clone()) {
                    map.insert(key, json);
                }
            }
            Json::Object(map)
        }
        ObjType::List => {
            let mut list = Vec::new();
            for i in 0..doc.length(obj) {
                if let Some(json) = get_json(doc, obj, i) {
                    list.push(json);
                }
            }
            Json::Array(list)
        }
        ObjType::Text => Json::String(doc.text(obj).unwrap_or_default()),
        _ => Json::Null,
    }
}

fn get_json(doc: &AutoCommit, obj: &ObjId, prop: impl Into<Prop>) -> Option<Json> {
    let (value, child) = doc.get(obj, prop).ok()??;
    Some(match value {
        Value::Object(ty) => obj_to_json(doc, &child, ty),
        Value::Scalar(s) => scalar_to_json(&s),
    })
}

fn scalar_to_json(s: &automerge::ScalarValue) -> Json {
    use automerge::ScalarValue;
    match s {
        ScalarValue::Str(v) => Json::String(v.to_string()),
        ScalarValue::Int(v) => Json::Number((*v).into()),
        ScalarValue::Uint(v) => Json::Number((*v).into()),
        ScalarValue::F64(v) => Json::from(*v),
        ScalarValue::Boolean(v) => Json::Bool(*v),
        ScalarValue::Counter(c) => serde_json::to_value(c).unwrap_or(Json::Null),
        ScalarValue::Timestamp(v) => Json::Number((*v).into()),
        _ => Json::Null,
    }
}

// ─── comms (Track S doc: mutations only; reading is gz_doc_json) ───────
//
// The comms doc schema lives in the main crate (src/comms.rs):
//
//   ROOT/messages/<id>/{dest, sender, text, created}
//   ROOT/reads/<msg id>            (unix-seconds scalar, absent = unread)
//
// Mirrored here, write-side only: the tablet reads through the generic
// JSON view and filters in Dart. Keeping mutations in Rust means the
// id scheme and schema stay exactly what the desktop replicas speak.
//
// The comms doc has no TTL logic here — expiry is client-side filtering
// in the main crate, and the FFI copy just writes what it's told.

use std::collections::HashSet;
use std::ffi::{c_char, CStr};
use std::time::{SystemTime, UNIX_EPOCH};

fn comms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn comms_map(doc: &AutoCommit, key: &str) -> Option<ObjId> {
    match doc.get(ROOT, key) {
        Ok(Some((Value::Object(ObjType::Map), id))) => Some(id),
        _ => None,
    }
}

fn comms_map_or_create(doc: &mut AutoCommit, key: &str) -> ObjId {
    if let Some(id) = comms_map(doc, key) {
        return id;
    }
    doc.put_object(ROOT, key, ObjType::Map)
        .unwrap_or_else(|e| panic!("comms: create root map {key}: {e}"))
}

fn comms_sval(doc: &AutoCommit, obj: &ObjId, key: &str) -> String {
    match doc.get(obj, key) {
        Ok(Some((Value::Scalar(s), _))) => match &*s {
            automerge::ScalarValue::Str(v) => v.to_string(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

fn comms_ival(doc: &AutoCommit, obj: &ObjId, key: &str) -> i64 {
    match doc.get(obj, key) {
        Ok(Some((Value::Scalar(s), _))) => match &*s {
            automerge::ScalarValue::Int(v) => *v,
            _ => 0,
        },
        _ => 0,
    }
}

/// Collision-free id among `existing` — same scheme as the main crate's
/// `fresh_id` (hash of time + salt, widening on collision).
fn comms_fresh_id(existing: &HashSet<String>) -> String {
    use std::hash::{Hash, Hasher};
    for len in [4usize, 6, 8, 12] {
        for salt in 0..64u64 {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            (nanos, salt, std::process::id()).hash(&mut h);
            let id = format!("{:016x}", h.finish())[..len].to_string();
            if !existing.contains(&id) {
                return id;
            }
        }
    }
    format!("{:016x}", u64::MAX)
}

/// Write a message into the comms doc: `messages/<fresh id>/{dest,
/// sender, text, created}`. Returns the full message as JSON
/// (including `read_at: 0`), or null on empty/invalid input.
///
/// # Safety
///
/// `doc` must be a valid `GzDoc` pointer or null (null returns null);
/// `dest`, `sender` and `text` must be NUL-terminated UTF-8 C strings or
/// null (any null returns null); `out_len` must be writable or null.
#[no_mangle]
pub unsafe extern "C" fn gz_comms_send(
    doc: *mut GzDoc,
    dest: *const c_char,
    sender: *const c_char,
    text: *const c_char,
    out_len: *mut usize,
) -> *mut u8 {
    if doc.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let read_str = |p: *const c_char| -> String {
        if p.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(p).to_string_lossy().into_owned() }
        }
    };
    let dest = read_str(dest).trim().to_string();
    let sender = read_str(sender).trim().to_string();
    let text = read_str(text).trim().to_string();
    if dest.is_empty() || sender.is_empty() || text.is_empty() {
        return std::ptr::null_mut();
    }
    let doc = unsafe { &mut *doc };
    let messages = comms_map_or_create(&mut doc.doc, "messages");
    let existing: HashSet<String> = doc.doc.keys(&messages).collect();
    let id = comms_fresh_id(&existing);
    let created = comms_now();
    let rec = doc
        .doc
        .put_object(&messages, &id, ObjType::Map)
        .unwrap_or_else(|e| panic!("comms: create message rec: {e}"));
    doc.doc
        .put(&rec, "dest", dest.as_str())
        .unwrap_or_else(|e| panic!("comms: put dest: {e}"));
    doc.doc
        .put(&rec, "sender", sender.as_str())
        .unwrap_or_else(|e| panic!("comms: put sender: {e}"));
    doc.doc
        .put(&rec, "text", text.as_str())
        .unwrap_or_else(|e| panic!("comms: put text: {e}"));
    doc.doc
        .put(&rec, "created", created)
        .unwrap_or_else(|e| panic!("comms: put created: {e}"));

    let json = serde_json::json!({
        "id": id,
        "dest": dest,
        "sender": sender,
        "text": text,
        "created": created,
        "read_at": 0,
    })
    .to_string();
    let bytes = json.into_bytes();
    unsafe { *out_len = bytes.len() };
    Box::into_raw(bytes.into_boxed_slice()) as *mut u8
}

/// Mark all unread messages addressed to `dest` as read (writes the
/// current time to `reads/<msg id>`). Returns `{"marked": n}` as JSON,
/// or null on invalid input. No TTL filter — matches the main crate.
///
/// # Safety
///
/// `doc` must be a valid `GzDoc` pointer or null (null returns null);
/// `dest` must be a NUL-terminated UTF-8 C string or null (null returns
/// null); `out_len` must be writable or null.
#[no_mangle]
pub unsafe extern "C" fn gz_comms_mark_read(
    doc: *mut GzDoc,
    dest: *const c_char,
    out_len: *mut usize,
) -> *mut u8 {
    if doc.is_null() || dest.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let dest = unsafe { CStr::from_ptr(dest) }.to_string_lossy().trim().to_string();
    if dest.is_empty() {
        return std::ptr::null_mut();
    }
    let doc = unsafe { &mut *doc };
    let Some(messages) = comms_map(&doc.doc, "messages") else {
        let bytes = b"{\"marked\":0}".to_vec();
        unsafe { *out_len = bytes.len() };
        return Box::into_raw(bytes.into_boxed_slice()) as *mut u8;
    };
    let reads = comms_map_or_create(&mut doc.doc, "reads");
    let t = comms_now();
    let mut marked = 0usize;
    for id in doc.doc.keys(&messages).collect::<Vec<_>>() {
        let rec = match doc.doc.get(&messages, &id) {
            Ok(Some((Value::Object(ObjType::Map), rec))) => rec,
            _ => continue,
        };
        if comms_sval(&doc.doc, &rec, "dest") != dest {
            continue;
        }
        if comms_ival(&doc.doc, &reads, &id) > 0 {
            continue;
        }
        doc.doc
            .put(&reads, &id, t)
            .unwrap_or_else(|e| panic!("comms: mark read: {e}"));
        marked += 1;
    }
    let json = serde_json::json!({ "marked": marked }).to_string();
    let bytes = json.into_bytes();
    unsafe { *out_len = bytes.len() };
    Box::into_raw(bytes.into_boxed_slice()) as *mut u8
}

/// Free a buffer returned by gz_doc_save / gz_doc_changes_since /
/// gz_doc_heads / gz_doc_json. Null or zero-length buffers are no-ops —
/// empty results come back as null, never a dangling pointer.
///
/// # Safety
///
/// `ptr` must be a buffer returned by this API with the matching `len`,
/// and must not have been freed already; null or zero-length is a no-op.
#[no_mangle]
pub unsafe extern "C" fn gz_buf_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len))) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    ffi_shims!();
    use automerge::transaction::Transactable;

    fn make_change(doc: &mut GzDoc, key: &str, value: &str) {
        doc.doc
            .put(automerge::ROOT, key, value)
            .expect("put succeeds");
        doc.doc.commit();
    }

    #[test]
    fn roundtrip_save_open_apply() {
        let mut a = GzDoc {
            doc: AutoCommit::new(),
        };
        make_change(&mut a, "hello", "world");

        let mut len = 0usize;
        let ptr = gz_doc_save(&mut a, &mut len);
        assert!(!ptr.is_null());
        let bytes = unsafe { slice::from_raw_parts(ptr, len) }.to_vec();
        gz_buf_free(ptr, len);

        let b = gz_doc_open(bytes.as_ptr(), bytes.len());
        assert!(!b.is_null());

        // b loaded a's save, but a peer with nothing gets the change
        let mut out_len = 0usize;
        let out = gz_doc_changes_since(b, std::ptr::null(), 0, &mut out_len);
        assert!(out_len > 0, "empty have => full change set");
        gz_buf_free(out, out_len);

        // heads round trip
        let mut count = 0usize;
        let heads = gz_doc_heads(b, &mut count);
        assert_eq!(count, 1);
        let head_bytes = unsafe { slice::from_raw_parts(heads, count * 32) }.to_vec();
        gz_buf_free(heads, count * 32);

        // a fresh doc with the same head: nothing new for it to send
        let c = gz_doc_new();
        let out = gz_doc_changes_since(c, head_bytes.as_ptr(), count, &mut out_len);
        assert_eq!(out_len, 0, "fresh doc has no changes");
        gz_buf_free(out, out_len);

        // the fresh doc applying a's change via the batch protocol sees it
        let out = gz_doc_changes_since(b, std::ptr::null(), 0, &mut out_len);
        assert!(out_len > 0);
        let batch = unsafe { slice::from_raw_parts(out, out_len) }.to_vec();
        gz_buf_free(out, out_len);
        let applied = gz_doc_apply(c, batch.as_ptr(), batch.len());
        assert_eq!(applied, 1);

        // after applying, c and b share the head: nothing left to send
        let out = gz_doc_changes_since(c, head_bytes.as_ptr(), count, &mut out_len);
        assert_eq!(out_len, 0, "converged: nothing new for the peer");
        gz_buf_free(out, out_len);
        gz_doc_free(c);
        gz_doc_free(b);
    }

    #[test]
    fn corrupt_inputs_return_errors() {
        let doc = gz_doc_new();
        assert_eq!(gz_doc_apply(doc, std::ptr::null(), 10), -1);
        // truncated batch
        let bad = [0u8; 2];
        assert_eq!(gz_doc_apply(doc, bad.as_ptr(), bad.len()), -1);
        gz_doc_free(doc);
        assert!(gz_doc_open(b"not a doc".as_ptr(), 9).is_null());
    }

    // ── comms ──

    fn cstr(s: &str) -> std::ffi::CString {
        std::ffi::CString::new(s).unwrap()
    }

    fn read_json(ptr: *mut u8, len: usize) -> Json {
        assert!(!ptr.is_null(), "expected a JSON payload");
        let bytes = unsafe { slice::from_raw_parts(ptr, len) }.to_vec();
        gz_buf_free(ptr, len);
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn comms_send_writes_the_message_schema() {
        let doc = gz_doc_new();
        let mut len = 0usize;
        let ptr = gz_comms_send(doc, cstr("agent-1").as_ptr(), cstr("tablet").as_ptr(), cstr("hello there").as_ptr(), &mut len);
        let msg = read_json(ptr, len);
        assert_eq!(msg["dest"], "agent-1");
        assert_eq!(msg["sender"], "tablet");
        assert_eq!(msg["text"], "hello there");
        assert_eq!(msg["read_at"], 0);
        let id = msg["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());
        assert!(msg["created"].as_i64().unwrap() > 0);

        // the doc's JSON view shows the same record under messages/<id>
        let mut jlen = 0usize;
        let jptr = gz_doc_json(doc, &mut jlen);
        let view = read_json(jptr, jlen);
        let rec = &view["messages"][&id];
        assert_eq!(rec["dest"], "agent-1");
        assert_eq!(rec["text"], "hello there");

        // empty fields rejected
        assert!(gz_comms_send(doc, cstr("").as_ptr(), cstr("t").as_ptr(), cstr("x").as_ptr(), &mut len).is_null());
        assert!(gz_comms_send(doc, cstr("d").as_ptr(), cstr(" ").as_ptr(), cstr("x").as_ptr(), &mut len).is_null());
        gz_doc_free(doc);
    }

    #[test]
    fn comms_send_ids_do_not_collide_and_messages_survive_roundtrip() {
        let doc = gz_doc_new();
        let mut len = 0usize;
        let mut ids = Vec::new();
        for i in 0..5 {
            let ptr = gz_comms_send(doc, cstr("a").as_ptr(), cstr("s").as_ptr(), cstr(&format!("m{i}")).as_ptr(), &mut len);
            let msg = read_json(ptr, len);
            ids.push(msg["id"].as_str().unwrap().to_string());
        }
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), 5, "ids must not collide");

        // save/open roundtrip preserves messages (same bytes as the hub)
        let mut slen = 0usize;
        let sptr = gz_doc_save(doc, &mut slen);
        let bytes = unsafe { slice::from_raw_parts(sptr, slen) }.to_vec();
        gz_buf_free(sptr, slen);
        let doc2 = gz_doc_open(bytes.as_ptr(), bytes.len());
        let mut jlen = 0usize;
        let jptr = gz_doc_json(doc2, &mut jlen);
        let view = read_json(jptr, jlen);
        assert_eq!(view["messages"].as_object().unwrap().len(), 5);
        gz_doc_free(doc2);
        gz_doc_free(doc);
    }

    #[test]
    fn apply_hashes_reports_applied_change_hashes() {
        let mut a = GzDoc {
            doc: AutoCommit::new(),
        };
        make_change(&mut a, "k", "v");

        let c = gz_doc_new();
        let mut out_len = 0usize;
        let out = gz_doc_changes_since(&mut a, std::ptr::null(), 0, &mut out_len);
        assert!(out_len > 0, "sender has a change to give");
        let batch = unsafe { slice::from_raw_parts(out, out_len) }.to_vec();
        gz_buf_free(out, out_len);

        // expected heads of c after applying = a's heads
        let mut hcount = 0usize;
        let hptr = gz_doc_heads(&mut a, &mut hcount);
        let heads = unsafe { slice::from_raw_parts(hptr, hcount * 32) }.to_vec();
        gz_buf_free(hptr, hcount * 32);

        let mut rlen = 0usize;
        let rptr = gz_doc_apply_hashes(c, batch.as_ptr(), batch.len(), &mut rlen);
        assert!(!rptr.is_null());
        let hashes = unsafe { slice::from_raw_parts(rptr, rlen) }.to_vec();
        gz_buf_free(rptr, rlen);
        assert_eq!(hashes, heads, "applied hashes == resulting heads");

        // feed those hashes back as "have": the doc has nothing new for them
        let out = gz_doc_changes_since(c, hashes.as_ptr(), (hashes.len() / 32) as usize, &mut out_len);
        assert_eq!(out_len, 0);
        gz_buf_free(out, out_len);
        gz_doc_free(c);
    }

    #[test]
    fn comms_mark_read_stamps_only_unread_to_dest() {
        let doc = gz_doc_new();
        let mut len = 0usize;
        gz_comms_send(doc, cstr("agent-1").as_ptr(), cstr("s").as_ptr(), cstr("m1").as_ptr(), &mut len);
        gz_comms_send(doc, cstr("agent-1").as_ptr(), cstr("s").as_ptr(), cstr("m2").as_ptr(), &mut len);
        gz_comms_send(doc, cstr("agent-2").as_ptr(), cstr("s").as_ptr(), cstr("other").as_ptr(), &mut len);

        let ptr = gz_comms_mark_read(doc, cstr("agent-1").as_ptr(), &mut len);
        let res = read_json(ptr, len);
        assert_eq!(res["marked"], 2);

        // second call is a no-op
        let ptr = gz_comms_mark_read(doc, cstr("agent-1").as_ptr(), &mut len);
        assert_eq!(read_json(ptr, len)["marked"], 0);

        // reads visible in the JSON view, other dest untouched
        let mut jlen = 0usize;
        let jptr = gz_doc_json(doc, &mut jlen);
        let view = read_json(jptr, jlen);
        assert_eq!(view["reads"].as_object().unwrap().len(), 2);
        gz_doc_free(doc);
    }
}

#[cfg(test)]
mod iso {
    use super::*;
    ffi_shims!();
    use automerge::transaction::Transactable;

    /// Minimal: fresh doc applies a batch. Isolates the roundtrip crash.
    #[test]
    fn fresh_doc_applies_batch() {
        let mut a = GzDoc {
            doc: AutoCommit::new(),
        };
        a.doc.put(automerge::ROOT, "hello", "world").unwrap();
        a.doc.commit();

        let mut out_len = 0usize;
        let out = gz_doc_changes_since(&mut a, std::ptr::null(), 0, &mut out_len);
        assert!(out_len > 0);
        let batch = unsafe { slice::from_raw_parts(out, out_len) }.to_vec();
        gz_buf_free(out, out_len);

        let c = gz_doc_new();
        let applied = gz_doc_apply(c, batch.as_ptr(), batch.len());
        assert_eq!(applied, 1);
        gz_doc_free(c);
    }
}

#[cfg(test)]
mod iso2 {
    use super::*;
    ffi_shims!();
    use automerge::transaction::Transactable;

    /// Does get_changes with a have-hash the doc doesn't know corrupt the doc?
    #[test]
    fn changes_since_unknown_hash_then_apply() {
        let mut a = GzDoc {
            doc: AutoCommit::new(),
        };
        a.doc.put(automerge::ROOT, "hello", "world").unwrap();
        a.doc.commit();

        // the have-hash comes from b (a peer that has the change)
        let mut count = 0usize;
        let heads = gz_doc_heads(&mut a, &mut count);
        assert_eq!(count, 1);
        let head_bytes = unsafe { slice::from_raw_parts(heads, count * 32) }.to_vec();
        gz_buf_free(heads, count * 32);

        let mut out_len = 0usize;
        let out = gz_doc_changes_since(&mut a, std::ptr::null(), 0, &mut out_len);
        let batch = unsafe { slice::from_raw_parts(out, out_len) }.to_vec();
        gz_buf_free(out, out_len);

        // fresh doc: ask for changes given a have-hash it does NOT have
        let c = gz_doc_new();
        let out = gz_doc_changes_since(c, head_bytes.as_ptr(), count, &mut out_len);
        eprintln!("out_len after unknown-have: {out_len}");
        if !out.is_null() {
            gz_buf_free(out, out_len);
        }

        let applied = gz_doc_apply(c, batch.as_ptr(), batch.len());
        assert_eq!(applied, 1);
        gz_doc_free(c);
    }
}

#[test]
fn json_view_walks_maps_and_scalars() {
    use automerge::transaction::Transactable;
    let mut doc = GzDoc {
        doc: AutoCommit::new(),
    };
    doc.doc.put(ROOT, "title", "hello").unwrap();
    doc.doc.put(ROOT, "priority", 3i64).unwrap();
    let items = doc
        .doc
        .put_object(ROOT, "items", automerge::ObjType::Map)
        .unwrap();
    let scope = doc
        .doc
        .put_object(items, "explorations/gzero", automerge::ObjType::Map)
        .unwrap();
    let it = doc
        .doc
        .put_object(scope, "abc123", automerge::ObjType::Map)
        .unwrap();
    doc.doc.put(&it, "title", "wire up projects").unwrap();
    doc.doc.put(&it, "status", "in_progress").unwrap();
    doc.doc.put(&it, "priority", 5i64).unwrap();
    doc.doc.commit();
    let view: serde_json::Value = serde_json::from_slice(&doc.doc.save()).unwrap_or(Json::Null);
    let _ = view; // (sanity: save still works)
    let json = obj_to_json(&doc.doc, &ROOT, ObjType::Map);
    let items_scope = &json["items"]["explorations/gzero"]["abc123"];
    assert_eq!(items_scope["title"], "wire up projects");
    assert_eq!(items_scope["status"], "in_progress");
    assert_eq!(items_scope["priority"], 5);
    assert_eq!(json["title"], "hello");
    assert_eq!(json["priority"], 3);
}
