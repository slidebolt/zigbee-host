import assert from "node:assert/strict";
import test from "node:test";
import {commandValues, normalizeDevice} from "./component-model.js";
import type {DeviceInfo} from "./types.js";

const bulb: DeviceInfo = {
  ieeeAddress: "0x00124b0000000001", networkAddress: 1, type: "Router", interviewState: "SUCCESSFUL",
  manufacturerName: "sengled", modelID: "E11-N1EA", reachability: {status: "reachable"},
  definition: {vendor: "Sengled", model: "E11-N1EA", description: "Dimmable bulb", generated: false},
  exposes: [
    {property: "state", category: "light", type: "binary", access: 7, values: ["ON", "OFF"]},
    {property: "brightness", category: "light", type: "numeric", access: 7, valueMin: 0, valueMax: 254},
    {property: "power", category: "numeric", type: "numeric", access: 5, unit: "W"},
  ],
};

test("normalization groups light features and separates sensors", () => {
  const device = normalizeDevice(bulb, {state: "ON", brightness: 40, power: 2.5});
  assert.equal(device.available, true);
  assert.deepEqual(device.components.map((component) => [component.id, component.kind]), [["default-light", "light"], ["default-power", "sensor"]]);
  assert.deepEqual(device.components[0]!.state, {power: "ON", brightness: 40});
  assert.deepEqual(commandValues(device.components[0]!, "set_brightness", {brightness: 12}), {brightness: 12});
});

test("generic writable binary exposes use their actual property", () => {
  const device = normalizeDevice({...bulb, exposes: [{property: "child_lock", type: "binary", access: 3, values: ["LOCK", "UNLOCK"]}]}, {child_lock: "UNLOCK"});
  const component = device.components[0]!;
  assert.deepEqual(commandValues(component, "turn_on", {}), {child_lock: "LOCK"});
  assert.deepEqual(commandValues(component, "turn_off", {}), {child_lock: "UNLOCK"});
});
