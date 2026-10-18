// Tests for compat.ts: the Workers AI null-content fix must touch only
// @cf/ payloads with assistant tool-call messages lacking content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixAssistantNullContent } from "../router/compat.ts";

const payload = {
  model: "@cf/qwen/qwen3-30b-a3b-fp8",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "fix it" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "edit", arguments: "{}" } }] },
    { role: "tool", content: "done", tool_call_id: "c1" },
  ],
};

test("replaces null content on @cf/ assistant tool-call messages", () => {
  const fixed = fixAssistantNullContent(payload) as typeof payload;
  const assistant = fixed.messages[2] as Record<string, unknown>;
  assert.equal(assistant.content, "");
  assert.equal(assistant.tool_calls, payload.messages[2].tool_calls);
  // other messages untouched
  assert.equal(fixed.messages[1], payload.messages[1]);
  // returns a new object
  assert.notEqual(fixed, payload);
});

test("unchanged @cf/ payload is returned as-is (same reference)", () => {
  const p = { model: "@cf/x", messages: [{ role: "user", content: "hi" }] };
  assert.equal(fixAssistantNullContent(p), p);
});

test("non-@cf/ models are untouched", () => {
  const p = { model: "anthropic/claude-x", messages: [{ role: "assistant", content: null, tool_calls: [] }] };
  assert.equal(fixAssistantNullContent(p), p);
});

test("non-object payloads pass through", () => {
  assert.equal(fixAssistantNullContent("string"), "string");
  assert.equal(fixAssistantNullContent(null), null);
});
