import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {HostEventHub} from "./observability.js";
import {parseDeviceIdSet, parseDiagnosticSnapshotOptions, ZigbeeDiagnosticSnapshotLoop} from "./diagnostics.js";
import type {DeviceInfo} from "./types.js";

function device(id: string, reachability: DeviceInfo["reachability"]): DeviceInfo {
  return {
    ieeeAddress: id,
    networkAddress: 123,
    type: "Router",
    interviewState: "SUCCESSFUL",
    manufacturerName: "Sengled",
    modelID: "E11-N1EA",
    exposes: [],
    reachability,
  };
}

test("diagnostic JSONL writer records filtered Zigbee lifecycle events", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zigbee-diagnostics-"));
  const diagnostics = path.join(directory, "diagnostics");
  const hub = await HostEventHub.create(directory, 100, {
    enabled: true,
    directory: diagnostics,
    deviceIds: new Set(["0xkeep"]),
  });
  try {
    hub.emit("zigbee_service.convert_set.done", {device: "0xkeep", property: "brightness", durationMs: 42});
    hub.emit("zigbee_service.convert_set.done", {device: "0xskip", property: "brightness", durationMs: 12});
    hub.emit("host_heartbeat", {connected: true});
  } finally {
    await hub.close();
  }

  const log = await readFile(path.join(diagnostics, `zigbee-health-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  const records = log.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.event, "zigbee_service.convert_set.done");
  assert.equal(records[0]!.deviceId, "0xkeep");
  assert.equal(records[0]!.property, "brightness");
  assert.equal(records[0]!.durationMs, 42);

  await rm(directory, {recursive: true, force: true});
});

test("diagnostic snapshot loop emits filtered device reachability snapshots", async () => {
  const events: Array<{event: string; data: Record<string, unknown>}> = [];
  const loop = new ZigbeeDiagnosticSnapshotLoop({
    enabled: true,
    intervalMs: 60_000,
    deviceIds: new Set(["0xkeep"]),
    port: {
      async listDevices() {
        return [
          device("0xkeep", {status: "reachable", lastSuccess: "2026-07-28T12:00:00.000Z"}),
          device("0xskip", {status: "unreachable", lastFailure: {at: "2026-07-28T12:00:00.000Z", code: "device_unreachable", phase: "read", detail: "failed"}}),
        ];
      },
    },
    output(event, data) {
      events.push({event, data: data as Record<string, unknown>});
    },
  });

  await loop.snapshot("test");

  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, "zigbee_diag.snapshot");
  assert.equal(events[0]!.data.count, 1);
  assert.deepEqual((events[0]!.data.devices as Array<Record<string, unknown>>).map((item) => item.id), ["0xkeep"]);
});

test("diagnostic option parsing normalizes device ids and clamps snapshot interval", () => {
  assert.deepEqual(parseDeviceIdSet(" 0xABC,0xdef\n0x123 "), new Set(["0xabc", "0xdef", "0x123"]));
  assert.equal(parseDiagnosticSnapshotOptions({ZIGBEE_DIAG_ENABLED: "1", ZIGBEE_DIAG_SNAPSHOT_INTERVAL_SECONDS: "1"}).intervalMs, 30_000);
  assert.equal(parseDiagnosticSnapshotOptions({ZIGBEE_DIAG_ENABLED: "1", ZIGBEE_DIAG_SNAPSHOT_INTERVAL_SECONDS: "99999"}).intervalMs, 3_600_000);
});
