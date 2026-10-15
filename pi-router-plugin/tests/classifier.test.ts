// Tests for classifier.ts: state truncation, the question shape, and the
// interpretation rules (argmax over known types, threshold, error → null).
// The classify function is injected, so a fake model + canned results cover
// everything without the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
type ClassifierModelForTest = ClassifierModel<ClassifierApi>;
import { PROMPT_SLICE, TOOL_TAIL_SLICE, WORK_TYPE_QUESTION, buildClassifierState, classifyWorkType } from "../classifier.ts";
import { WORK_TYPES } from "../config.ts";

function fakeModel() {
  return { provider: "cloudflare-workers-ai", id: "fake-clef", api: "system-one" } as never;
}

function choiceResult(probabilities: Record<string, number>, choice = "fix-errors"): ClassifierResult {
  return {
    answers: {
      workType: { type: "choice", choice, probabilities, confidence: 0.4 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as unknown as ClassifierResult;
}

function erroredResult(): ClassifierResult {
  return { answers: {}, stopReason: "error", errorMessage: "boom", timestamp: 0 } as unknown as ClassifierResult;
}

test("WORK_TYPE_QUESTION covers exactly the seven work types", () => {
  assert.equal(WORK_TYPE_QUESTION.type, "choice");
  assert.deepEqual(Object.keys(WORK_TYPE_QUESTION.criteria).sort(), [...WORK_TYPES].sort());
});

test("buildClassifierState truncates prompt to the head and tool tail to the tail", () => {
  const prompt = "x".repeat(PROMPT_SLICE + 100);
  const tail = "y".repeat(TOOL_TAIL_SLICE + 100);
  const state = buildClassifierState({ prompt, recentToolOutput: tail, lastWorkType: "plan" });
  assert.equal(state.prompt.length, PROMPT_SLICE);
  assert.equal(state.recentToolOutput.length, TOOL_TAIL_SLICE);
  // prompt keeps its start, tail keeps its end (recent output matters most)
  assert.equal(state.prompt, "x".repeat(PROMPT_SLICE));
  assert.equal(state.recentToolOutput.endsWith("y"), true);
  assert.equal(state.lastWorkType, "plan");
});

test("buildClassifierState defaults", () => {
  const state = buildClassifierState({ prompt: "hi" });
  assert.deepEqual(state, { prompt: "hi", recentToolOutput: "", lastWorkType: null });
});

test("classifyWorkType picks the argmax among known types", async () => {
  const calls: ClassifierContext[] = [];
  const classify = async (_model: ClassifierModelForTest, context: ClassifierContext) => {
    calls.push(context);
    return choiceResult({ "fix-errors": 0.55, "fix-warnings": 0.2, mystery: 0.25 });
  };
  const result = await classifyWorkType(classify, fakeModel(), buildClassifierState({ prompt: "fix this" }), { threshold: 0.5 });
  assert.equal(result.workType, "fix-errors");
  assert.equal(result.probabilities["fix-errors"], 0.55);
  assert.equal("mystery" in result.probabilities, false);
  // the question carried the criteria and the state rode along
  const ctx = calls[0];
  assert.equal(ctx.questions.workType.type, "choice");
  assert.deepEqual((ctx.state as { prompt: string }).prompt, "fix this");
});

test("below threshold → null workType but probabilities preserved", async () => {
  const classify = async () => choiceResult({ "easy-codefix": 0.4, "fix-errors": 0.35 });
  const result = await classifyWorkType(classify, fakeModel(), buildClassifierState({ prompt: "p" }), { threshold: 0.5 });
  assert.equal(result.workType, null);
  assert.equal(result.confidence, 0.4);
  assert.equal(result.probabilities["easy-codefix"], 0.4);
});

test("classifier error and non-choice answers → null", async () => {
  const bad = await classifyWorkType(async () => erroredResult(), fakeModel(), buildClassifierState({ prompt: "p" }), { threshold: 0.5 });
  assert.equal(bad.workType, null);
  assert.equal(bad.raw?.stopReason, "error");

  const nonChoice = await classifyWorkType(
    async () => ({ answers: { workType: { type: "bool", value: true } }, stopReason: "stop", timestamp: 0 }) as unknown as ClassifierResult,
    fakeModel(),
    buildClassifierState({ prompt: "p" }),
    { threshold: 0.5 },
  );
  assert.equal(nonChoice.workType, null);
});

test("no probabilities on any known type → null", async () => {
  const classify = async () => choiceResult({ mystery: 1 }, "mystery");
  const result = await classifyWorkType(classify, fakeModel(), buildClassifierState({ prompt: "p" }), { threshold: 0.5 });
  assert.equal(result.workType, null);
});
