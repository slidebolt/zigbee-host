import assert from "node:assert/strict";
import test from "node:test";
import {ReachabilityTracker} from "./reachability.js";

const failure = {at: "t", code: "device_unreachable", phase: "read" as const, detail: "Delivery failed"};

test("repeated successes report a change only on the first", () => {
  const tracker = new ReachabilityTracker();
  tracker.ensure("0x1");
  assert.equal(tracker.markReachable("0x1", "a").changed, true);
  assert.equal(tracker.markReachable("0x1", "b").changed, false);
  assert.equal(tracker.markReachable("0x1", "c").changed, false);
  assert.equal(tracker.get("0x1")?.lastSeen, "c");
});

test("repeated failures report a change only on the first, and keep lastSeen", () => {
  const tracker = new ReachabilityTracker();
  tracker.markReachable("0x1", "seen");
  assert.equal(tracker.markUnreachable("0x1", "device_unreachable", failure).changed, true);
  assert.equal(tracker.markUnreachable("0x1", "device_unreachable", failure).changed, false);
  const record = tracker.get("0x1");
  assert.equal(record?.status, "unreachable");
  assert.equal(record?.lastSeen, "seen");
  assert.equal(tracker.markReachable("0x1").changed, true);
});

test("after a coordinator disconnect the next success is a change again", () => {
  const tracker = new ReachabilityTracker();
  tracker.markReachable("0x1");
  tracker.markAllUnknown("coordinator_disconnected");
  assert.equal(tracker.get("0x1")?.status, "unknown");
  assert.equal(tracker.markReachable("0x1").changed, true);
});
