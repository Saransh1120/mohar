import assert from "node:assert/strict";
import test from "node:test";
import { observeDeviceSequence } from "./device-seq.js";

test("first signed sequence and contiguous next sequence have no gap", () => {
  assert.deepEqual(observeDeviceSequence(0, 1), { kind: "next" });
  assert.deepEqual(observeDeviceSequence(7, 8), { kind: "next" });
});

test("a skipped signed sequence reports exact missing count", () => {
  assert.deepEqual(observeDeviceSequence(4, 7), {
    kind: "gap", lastSeenSeq: 4, receivedSeq: 7, missingCount: 2,
  });
});

test("legacy events and regressions are distinct from gaps", () => {
  assert.deepEqual(observeDeviceSequence(4, undefined), { kind: "missing" });
  assert.deepEqual(observeDeviceSequence(4, 4), {
    kind: "regression", lastSeenSeq: 4, receivedSeq: 4,
  });
});
