import assert from "node:assert/strict";
import test from "node:test";
import {parseWarmLoopOptions, retryDelayMs, selectWarmTargets, ZigbeeWarmLoop, type WarmLoopOptions} from "./warm-loop.js";
import type {DeviceInfo} from "./types.js";

function device(id: string, exposes: DeviceInfo["exposes"]): DeviceInfo {
  return {
    ieeeAddress: id,
    networkAddress: 1,
    type: "EndDevice",
    interviewState: "SUCCESSFUL",
    exposes,
  };
}

test("selectWarmTargets selects only readable light exposes for the configured property", () => {
  const targets = selectWarmTargets([
    device("0x0000000000000001", [{property: "brightness", type: "numeric", access: 7, category: "light"}]),
    device("0x0000000000000002", [{property: "brightness", type: "numeric", access: 3, category: "light"}]),
    device("0x0000000000000003", [{property: "brightness", type: "numeric", access: 7, category: "sensor"}]),
    device("0x0000000000000004", [{property: "state", type: "binary", access: 7, category: "light"}]),
  ], {property: "brightness"});
  assert.deepEqual(targets, [{deviceId: "0x0000000000000001", property: "brightness"}]);
});

test("selectWarmTargets honors an explicit device allow-list", () => {
  const targets = selectWarmTargets([
    device("0x0000000000000001", [{property: "brightness", type: "numeric", access: 7, category: "light"}]),
    device("0x0000000000000002", [{property: "brightness", type: "numeric", access: 7, category: "light", endpoint: "left"}]),
  ], {property: "brightness", deviceIds: new Set(["0x0000000000000002"])});
  assert.deepEqual(targets, [{deviceId: "0x0000000000000002", property: "brightness", endpoint: "left"}]);
});

test("selectWarmTargets keeps trying devices currently marked unreachable", () => {
  const targets = selectWarmTargets([
    {...device("0x0000000000000001", [{property: "brightness", type: "numeric", access: 7, category: "light"}]), reachability: {status: "unreachable" as const}},
    {...device("0x0000000000000002", [{property: "brightness", type: "numeric", access: 7, category: "light"}]), reachability: {status: "reachable" as const}},
  ], {property: "brightness"});
  assert.deepEqual(targets, [
    {deviceId: "0x0000000000000001", property: "brightness"},
    {deviceId: "0x0000000000000002", property: "brightness"},
  ]);
});

test("parseWarmLoopOptions uses conservative bounded values", () => {
  const options = parseWarmLoopOptions({
    ZIGBEE_WARM_ENABLED: "true",
    ZIGBEE_WARM_INTERVAL_SECONDS: "1",
    ZIGBEE_WARM_JITTER_MS: "999999",
    ZIGBEE_WARM_CONCURRENCY: "0",
    ZIGBEE_WARM_SLOW_READ_MS: "10",
    ZIGBEE_WARM_PROPERTY: "state",
    ZIGBEE_WARM_DEVICE_IDS: "0x1, 0x2",
  });
  assert.equal(options.enabled, true);
  assert.equal(options.intervalMs, 5_000);
  assert.equal(options.jitterMs, 60_000);
  assert.equal(options.concurrency, 1);
  assert.equal(options.slowReadMs, 100);
  assert.equal(options.property, "state");
  assert.deepEqual(options.deviceIds, new Set(["0x1", "0x2"]));
  assert.equal(options.failThreshold, 2);
  assert.equal(options.unreachableMaxMs, 900_000);
});

test("parseWarmLoopOptions bounds the backoff settings", () => {
  const low = parseWarmLoopOptions({ZIGBEE_WARM_FAIL_THRESHOLD: "0", ZIGBEE_WARM_UNREACHABLE_MAX_SECONDS: "1"});
  assert.equal(low.failThreshold, 1);
  assert.equal(low.unreachableMaxMs, 60_000);
  const high = parseWarmLoopOptions({ZIGBEE_WARM_FAIL_THRESHOLD: "99", ZIGBEE_WARM_UNREACHABLE_MAX_SECONDS: "999999"});
  assert.equal(high.failThreshold, 20);
  assert.equal(high.unreachableMaxMs, 86_400_000);
});

test("retryDelayMs keeps the interval below the threshold, then doubles up to the cap", () => {
  const options = {intervalMs: 30_000, failThreshold: 2, unreachableMaxMs: 900_000};
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 50].map((failures) => retryDelayMs(failures, options)),
    [30_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  // A slow interval is never undercut by the backoff base.
  assert.deepEqual([1, 2, 3, 4].map((failures) => retryDelayMs(failures, {...options, intervalMs: 300_000})),
    [300_000, 300_000, 600_000, 900_000]);
});

const SECOND = 1_000;

function light(id: string): DeviceInfo {
  return device(id, [{property: "brightness", type: "numeric", access: 7, category: "light"}]);
}

/** Virtual-clock harness: reads complete after a fixed virtual duration, success or failure per device. */
function harness(options: {healthy: string[]; failing: string[]; overrides?: Partial<WarmLoopOptions>}) {
  let now = 0;
  const reads: Array<{deviceId: string; at: number}> = [];
  const events: Array<{event: string; data: Record<string, unknown>}> = [];
  const pending: Array<{done: number; settle: () => void}> = [];
  const failing = new Set(options.failing);
  const loop = new ZigbeeWarmLoop({
    enabled: true,
    intervalMs: 30 * SECOND,
    jitterMs: 0,
    concurrency: 2,
    slowReadMs: 60_000,
    property: "brightness",
    failThreshold: 2,
    unreachableMaxMs: 900 * SECOND,
    ...options.overrides,
    now: () => now,
    port: {
      listDevices: async () => [...options.healthy, ...options.failing].map(light),
      get: (deviceId) => {
        reads.push({deviceId, at: now});
        return new Promise((resolve, reject) => {
          // Healthy bulbs answer in ~0.3 s; absent bulbs time out after ~4.8 s.
          if (failing.has(deviceId)) pending.push({done: now + 4_800, settle: () => reject(new Error("Delivery failed"))});
          else pending.push({done: now + 300, settle: () => resolve({brightness: 1})});
        });
      },
    },
    output: (event, data) => events.push({event, data: data as Record<string, unknown>}),
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  async function run(untilMs: number, stepMs = 100): Promise<void> {
    while (now < untilMs) {
      now += stepMs;
      for (const item of pending.filter((entry) => entry.done <= now)) {
        pending.splice(pending.indexOf(item), 1);
        item.settle();
      }
      await flush();
      if (now % SECOND === 0) await loop.tick();
      await flush();
    }
  }
  return {loop, reads, events, run, setFailing: (id: string, value: boolean) => (value ? failing.add(id) : failing.delete(id)), now: () => now};
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((time, index) => time - times[index]!);
}

test("absent bulbs are backed off and never starve answering bulbs of read slots", async () => {
  const healthy = Array.from({length: 11}, (_, i) => `0x${(i + 1).toString(16).padStart(16, "0")}`);
  const failing = Array.from({length: 10}, (_, i) => `0x${(i + 0x100).toString(16).padStart(16, "0")}`);
  const h = harness({healthy, failing});
  await h.run(20 * 60 * SECOND);

  for (const id of healthy) {
    const times = h.reads.filter((read) => read.deviceId === id).map((read) => read.at);
    assert.ok(times.length >= 35, `${id} read ${times.length} times in 20 min`);
    // After the first minute (both outage reads per absent bulb), every answering bulb keeps a ~30 s cadence:
    // interval + read time + at most a few seconds waiting for a slot held by an absent bulb's retry.
    const late = gaps(times.filter((time) => time >= 60 * SECOND));
    assert.ok(Math.max(...late) <= 36 * SECOND, `${id} max gap ${Math.max(...late)}ms`);
  }
  for (const id of failing) {
    const times = h.reads.filter((read) => read.deviceId === id).map((read) => read.at);
    // ~0, +30, then +60, +120, +240, +480, +900 ... -> about 6 reads in 20 minutes instead of 40.
    assert.ok(times.length <= 7, `${id} read ${times.length} times in 20 min`);
    const spacing = gaps(times);
    for (let i = 2; i < spacing.length; i++) assert.ok(spacing[i]! >= spacing[i - 1]!, `${id} spacing should not shrink: ${spacing.join(",")}`);
  }
  // Exactly one "became unreachable" failure per absent bulb.
  const outages = h.events.filter((entry) => entry.event === "zigbee_warm.read.failed" && entry.data.unreachable);
  assert.equal(outages.length, failing.length);
});

test("a backed-off bulb returns to the normal schedule when it is seen again", async () => {
  const id = "0x00000000000000aa";
  const h = harness({healthy: [], failing: [id]});
  await h.run(10 * 60 * SECOND);
  const before = h.loop.schedule()[0]!;
  assert.ok(before.failures >= 3);
  assert.ok(before.nextDueAt - h.now() > 30 * SECOND, "should be backed off");

  h.setFailing(id, false);
  h.loop.noteSeen(id.toUpperCase());
  const after = h.loop.schedule()[0]!;
  assert.equal(after.failures, 0);
  assert.ok(after.nextDueAt - h.now() <= 30 * SECOND);
  assert.ok(h.events.some((entry) => entry.event === "zigbee_warm.read.recovered"));

  const readsBefore = h.reads.length;
  await h.run(h.now() + 2 * 60 * SECOND);
  assert.ok(h.reads.length - readsBefore >= 3, "back on a ~30 s cadence");
});

test("a bulb that answers again on its own backoff read recovers", async () => {
  const id = "0x00000000000000bb";
  const h = harness({healthy: [], failing: [id]});
  await h.run(3 * 60 * SECOND);
  h.setFailing(id, false);
  await h.run(20 * 60 * SECOND);
  const recovered = h.events.filter((entry) => entry.event === "zigbee_warm.read.recovered");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.data.via, "read");
  assert.equal(h.loop.schedule()[0]!.failures, 0);
});
