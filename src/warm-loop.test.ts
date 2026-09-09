import assert from "node:assert/strict";
import test from "node:test";
import {parseWarmLoopOptions, selectWarmTargets} from "./warm-loop.js";
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
});
