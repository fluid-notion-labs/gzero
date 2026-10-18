#!/usr/bin/env python3
"""Drive scene-mcp (stdio MCP) to author the Flutter client plane diagram."""
import json, subprocess, sys, os

BIN = "/mnt/data/projects/explorations/nursery/scene-mcp/target/release/scene-mcp"
OUT = sys.argv[1] if len(sys.argv) > 1 else "flutter-client.glb"

proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, text=True, bufsize=1)
_next_id = [0]

def send(msg):
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()

def recv_until(want_id):
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("server closed")
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("id") == want_id:
            if "error" in msg:
                raise RuntimeError(json.dumps(msg["error"]))
            return msg

def call(name, args=None):
    _next_id[0] += 1
    i = _next_id[0]
    send({"jsonrpc": "2.0", "id": i, "method": "tools/call",
          "params": {"name": name, "arguments": args or {}}})
    r = recv_until(i)
    content = r["result"].get("content", [])
    text = " ".join(c.get("text", "") for c in content if c.get("type") == "text")
    m = None
    for c in content:
        if c.get("type") == "text":
            import re
            m = re.search(r"id=(\d+)", c.get("text", ""))
            if m:
                break
    return (int(m.group(1)) if m else None), text

def notify(method):
    send({"jsonrpc": "2.0", "method": method})

# --- initialize ---
_next_id[0] += 1
send({"jsonrpc": "2.0", "id": _next_id[0], "method": "initialize", "params": {
    "protocolVersion": "2025-03-26", "capabilities": {},
    "clientInfo": {"name": "flutter-scene-driver", "version": "0.1"}}})
recv_until(_next_id[0])
notify("notifications/initialized")

call("scene_new", {"path": os.path.abspath(OUT)})

SLAB = [9.0, 0.12, 5.4]
MINISLAB = [3.6, 0.08, 2.3]
BOX = [2.5, 0.9, 1.7]
MINIBOX = [0.95, 0.55, 0.85]
COL = [0.18, 2.48, 0.18]

def group(name, parent=None):
    return call("create_group", {"name": name, "parent": parent})[0]

def prim(kind, dims, name, parent=None, pos=None):
    a = {"kind": kind, "name": name, "dimensions": dims}
    if parent is not None: a["parent"] = parent
    if pos is not None: a["position"] = pos
    return call("add_primitive", a)[0]

def part(node, part_id, category, label, notes=None, material=None):
    a = {"id": node, "part_id": part_id, "category": category, "label": label}
    if notes: a["notes"] = notes
    if material: a["material"] = material
    return call("set_part_info", a)[0]

ids = {}

# ---------- Plane slabs (vertical stack, hub at the bottom) ----------
def slab(name, y_top, label, notes, material):
    g = group(name)
    s = prim("box", SLAB, name + " slab", g, [0, y_top - 0.06, 0])
    part(s, "plane." + label.split()[0].lower(), "plane", label, notes, material)
    ids[name] = (g, s, y_top)
    return g, s, y_top

# SURFACE (top)
g, s, Y = slab("SURFACE PLANE", 10.0, "SURFACE — Flutter widgets",
    "What the user touches. Bag screen (atom list, tag chips), resolve view "
    "(tag-pulled context preview), sync status card (last push/pull, peer "
    "counts, conflict list).", {"kind": "glass", "spec": "widget layer"})
for x, nm in [(-3.0, "Bag screen — atom list + tag chips"),
              (0.0,  "Resolve view — pulled context preview"),
              (3.0,  "Sync status card — push/pull, conflicts")]:
    b = prim("box", BOX, nm, g, [x, Y + 0.45, 0.8])
    part(b, "widget", "widget", nm.split(" — ")[0], nm, {"kind": "glass", "spec": "screen"})

# APP STATE
g, s, Y = slab("APP STATE PLANE", 7.4, "APP STATE — local stores + sync loop",
    "Owns the device-side replica and the sync loop. Two nested planes sit "
    "on this slab: LATTICE (merge semantics) and LOCAL REPLICA (persistence).",
    {"kind": "plasterboard", "spec": "state layer"})
b = prim("box", [2.5, 0.9, 1.2], "Sync controller — pull → merge → push", g, [0, Y + 0.45, 2.0])
part(b, "sync-controller", "state", "Sync controller", "pull → lattice merge → push", {"kind": "plasterboard", "spec": "loop"})

# nested: LATTICE PLANE
lat = group("LATTICE PLANE (nested)", g)
ml = prim("box", MINISLAB, "lattice slab", lat, [-2.2, 7.52 - 0.04, 0.15])
part(ml, "plane.lattice", "nested-plane", "LATTICE PLANE (nested)",
    "Merge semantics over the bag: OR-set union with tombstones; atom "
    "identity is its text — identical text converges.",
    {"kind": "insulation", "spec": "merge"})
for x, nm in [(-3.35, "OR-set union"), (-2.2, "Tombstones"), (-1.05, "Identity = atom text")]:
    mb = prim("box", MINIBOX, nm, lat, [x, 7.52 + 0.275, 0.15])
    part(mb, "lattice." + nm.split()[0].lower(), "merge", nm, None, {"kind": "insulation", "spec": "rule"})

# nested: LOCAL REPLICA PLANE
rep = group("LOCAL REPLICA PLANE (nested)", g)
mr = prim("box", MINISLAB, "replica slab", rep, [2.2, 7.52 - 0.04, 0.15])
part(mr, "plane.replica", "nested-plane", "LOCAL REPLICA PLANE (nested)",
    "Device-side persistence: SQLite keyed by atom text, single-writer WAL; "
    "survives offline; source for the sync controller.",
    {"kind": "wood-panel", "spec": "storage"})
for x, nm in [(1.6, "SQLite replica"), (2.8, "Single-writer WAL")]:
    mb = prim("box", MINIBOX, nm, rep, [x, 7.52 + 0.275, 0.15])
    part(mb, "replica." + nm.split()[0].lower(), "storage", nm, None, {"kind": "wood-panel", "spec": "local"})

# TRANSPORT
g, s, Y = slab("TRANSPORT PLANE", 4.8, "TRANSPORT — hub client",
    "Talks to the api server: HTTP push/pull of atom sets, SSE for remote "
    "changes, offline queue with retry/backoff, device-token auth.",
    {"kind": "plastic", "spec": "transport"})
for x, nm in [(-3.0, "Hub client — push/pull over HTTP"),
              (0.0,  "Offline queue — retry + backoff"),
              (3.0,  "Auth — device token")]:
    b = prim("box", BOX, nm, g, [x, Y + 0.45, 0.8])
    part(b, "transport." + nm.split(" — ")[0].lower(), "transport", nm.split(" — ")[0], nm, {"kind": "plastic", "spec": "channel"})

# HUB (api server, bottom)
g, s, Y = slab("HUB — API SERVER", 2.2, "HUB (api server) — gzero Worker",
    "The deployed Worker + DO replication spine the app speaks to. Nested "
    "plane: the SYNC DO bag-room doing server-side lattice merge.",
    {"kind": "concrete", "spec": "cloudflare"})
b = prim("box", BOX, "REST + SSE endpoints", g, [-3.0, Y + 0.45, 0.8])
part(b, "hub.endpoints", "api", "REST + SSE", "POST /sync push, GET /sync pull + SSE", {"kind": "concrete", "spec": "edge"})

do = group("SYNC DO (nested)", g)
md = prim("box", MINISLAB, "bag-room slab", do, [2.0, 2.32 - 0.04, 0.15])
part(md, "plane.syncdo", "nested-plane", "SYNC DO (nested)",
    "Durable Object per bag: authoritative OR-set + tombstones, lattice "
    "merge point for every machine, machine registry for fan-out.",
    {"kind": "steel", "spec": "durable object"})
for x, nm in [(0.85, "bag-room DO"), (2.0, "Lattice merge"), (3.15, "Machine registry")]:
    mb = prim("box", MINIBOX, nm, do, [x, 2.32 + 0.275, 0.15])
    part(mb, "do." + nm.split()[0].lower(), "sync", nm, None, {"kind": "steel", "spec": "room"})

# ---------- Connector columns (sync flows down to the hub, pulls up) ----------
def column(x, z, y_low, y_up, label, notes):
    h = (y_up - 0.12) - y_low
    c = prim("box", [0.18, h, 0.18], label, None, [x, y_low + h / 2, z])
    part(c, "flow", "flow", label, notes, {"kind": "metal-sheet", "spec": "link"})
    return c

column(0.0, -2.0, 7.4, 10.0, "widget ↔ state streams", "Bag store streams drive screens; user edits land in the store")
column(3.5, 1.8, 4.8, 7.4, "push ▼ new + tombstoned atoms", "Sync controller hands changed atoms down to the hub client")
column(-3.5, 1.8, 4.8, 7.4, "pull ▲ merged tip + SSE", "Merged remote changes rise into the replica, then the screens")
column(3.5, 1.8, 2.2, 4.8, "POST /sync ▼ push ops", "Atom ops pushed to the hub; DO merges server-side")
column(-3.5, 1.8, 2.2, 4.8, "GET /sync ▲ pull + SSE", "Pull merged tip; SSE pushes remote changes live")

call("scene_save")
tree_id, tree_text = call("get_tree")
print(tree_text)
proc.stdin.close()
proc.wait()
print("OK ->", OUT)
