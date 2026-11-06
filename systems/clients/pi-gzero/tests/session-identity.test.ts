import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionIdentity, sessionKey, uuidFromSeed } from "../session-identity.ts";

test("identity is stable across factory re-runs within one pi session", () => {
  // PI_SESSION_FILE anchors the id to the pi session, so an extension
  // reload (reinstall, snapshot swap) must not rotate it — a rotated id
  // strands every comms message addressed to the previous one.
  process.env.PI_SESSION_FILE =
    "/home/x/.pi/agent/sessions/some-repo/2026-11-05T22-25-43-854Z_01a1add1-65ad-74be-b0f2-73486d5b2116.jsonl";
  const a = sessionIdentity();
  const b = sessionIdentity();
  assert.equal(a.sessionId, b.sessionId);
  assert.match(a.sessionId, /^[0-9a-f-]{36}$/);
  delete process.env.PI_SESSION_FILE;
});

test("different pi sessions get different ids", () => {
  process.env.PI_SESSION_FILE = "/x/a.jsonl";
  const a = sessionIdentity().sessionId;
  process.env.PI_SESSION_FILE = "/x/b.jsonl";
  const b = sessionIdentity().sessionId;
  assert.notEqual(a, b);
  delete process.env.PI_SESSION_FILE;
});

test("outside pi the id is fresh per call (old behavior)", () => {
  const saved = process.env.PI_SESSION_FILE;
  delete process.env.PI_SESSION_FILE;
  assert.equal(sessionKey(), undefined);
  const a = sessionIdentity().sessionId;
  const b = sessionIdentity().sessionId;
  assert.notEqual(a, b);
  if (saved) process.env.PI_SESSION_FILE = saved;
});

test("uuidFromSeed is uuid-shaped and deterministic", () => {
  assert.equal(uuidFromSeed("seed"), uuidFromSeed("seed"));
  assert.notEqual(uuidFromSeed("seed"), uuidFromSeed("other"));
  // version nibble 5, variant a — cosmetic, but keeps rows uniform
  assert.match(uuidFromSeed("seed"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});
