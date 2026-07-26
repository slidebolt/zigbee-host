import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {toApiCapability, toApiDevice, toApiDeviceSummary} from "./host-server.js";
import {OPENAPI_DOCUMENT} from "./openapi.js";
import type {DeviceInfo} from "./types.js";

const device: DeviceInfo = {
  ieeeAddress: "0x00124b0000000001",
  networkAddress: 36610,
  type: "EndDevice",
  interviewState: "SUCCESSFUL",
  manufacturerName: "sengled",
  modelID: "E11-N1EA",
  definition: {vendor: "Sengled", model: "E11-N1EA", description: "Dimmable bulb", generated: false},
  exposes: [{property: "state", type: "enum", access: 7, values: ["ON", "OFF"]}],
};

test("public device resources use stable IDs and semantic capabilities", () => {
  assert.deepEqual(toApiDeviceSummary(device), {
    id: device.ieeeAddress, manufacturer: "Sengled", model: "E11-N1EA", kind: "end_device", interview: "successful", reachability: {status: "unknown"},
  });
  assert.deepEqual(toApiCapability(device.exposes[0]!), {
    name: "state", type: "enum", access: {read: true, write: true, reports: true}, values: ["ON", "OFF"],
  });
  assert.equal(toApiDevice(device).network.address, 36610);
});

test("only the canonical device command routes are documented and implemented", async () => {
  const paths = Object.keys(OPENAPI_DOCUMENT.paths);
  assert.ok(paths.includes("/v1/snapshot"));
  assert.ok(paths.includes("/v1/events"));
  assert.ok(paths.includes("/v1/devices/{deviceId}/components/{componentId}/commands"));
  assert.ok(paths.includes("/v1/pairing/start"));
  assert.ok(!paths.includes("/v1/devices/{deviceId}/state"));

  const source = await readFile(new URL("./host-server.js", import.meta.url), "utf8");
  assert.ok(source.includes("componentCommandMatch"));
  assert.ok(source.includes("event_cursor_expired"));
});
