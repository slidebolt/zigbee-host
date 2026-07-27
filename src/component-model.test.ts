import assert from "node:assert/strict";
import test from "node:test";
import {commandValues, normalizeDevice, statePatchForComponent} from "./component-model.js";
import type {DeviceInfo} from "./types.js";

const bulb: DeviceInfo = {
  ieeeAddress: "0x00124b0000000001", networkAddress: 1, type: "Router", interviewState: "SUCCESSFUL",
  manufacturerName: "sengled", modelID: "E11-N1EA", reachability: {status: "reachable"},
  definition: {vendor: "Sengled", model: "E11-N1EA", description: "Dimmable bulb", generated: false},
  exposes: [
    {property: "state", category: "light", type: "binary", access: 7, values: ["ON", "OFF"]},
    {property: "brightness", category: "light", type: "numeric", access: 7, valueMin: 0, valueMax: 254},
    {property: "color_temp", category: "light", type: "numeric", access: 7, valueMin: 153, valueMax: 500},
    {property: "color", category: "light", type: "composite", access: 7},
    {property: "power", category: "numeric", type: "numeric", access: 5, unit: "W"},
    {property: "energy", category: "numeric", type: "numeric", access: 5, unit: "kWh"},
  ],
};

test("normalization groups light features and separates sensors", () => {
  const device = normalizeDevice(bulb, {state: "ON", brightness: 40, power: 2.5});
  assert.equal(device.available, true);
  assert.deepEqual(device.components.map((component) => [component.id, component.kind]), [["default-energy", "sensor"], ["default-light", "light"], ["default-power", "sensor"]]);
  const light = device.components.find((component) => component.id === "default-light");
  assert.ok(light);
  assert.deepEqual(light.state, {power: "ON", brightness: 40});
  assert.deepEqual(commandValues(light, "turn_on", {}), {state: "ON"});
  assert.deepEqual(commandValues(light, "turn_off", {}), {state: "OFF"});
  assert.deepEqual(commandValues(light, "set_brightness", {brightness: 12}), {brightness: 12});
});

test("generic writable binary exposes use their actual property", () => {
  const device = normalizeDevice({...bulb, exposes: [{property: "child_lock", type: "binary", access: 3, values: ["LOCK", "UNLOCK"]}]}, {child_lock: "UNLOCK"});
  const component = device.components[0]!;
  assert.deepEqual(commandValues(component, "turn_on", {}), {child_lock: "LOCK"});
  assert.deepEqual(commandValues(component, "turn_off", {}), {child_lock: "UNLOCK"});
});

test("light power commands use Zigbee state strings when canonical values are absent", () => {
  const device = normalizeDevice({...bulb, exposes: [{property: "state", category: "light", type: "binary", access: 7}]}, {state: "ON"});
  const component = device.components[0]!;
  assert.deepEqual(component.features.power?.values, undefined);
  assert.deepEqual(commandValues(component, "turn_on", {}), {state: "ON"});
  assert.deepEqual(commandValues(component, "turn_off", {}), {state: "OFF"});
});

test("state patches keep light power separate from metering power", () => {
  const device = normalizeDevice(bulb, {state: "OFF", brightness: 40, power: 2.5, energy: 0.1});
  const light = device.components.find((component) => component.id === "default-light");
  const power = device.components.find((component) => component.id === "default-power");
  const energy = device.components.find((component) => component.id === "default-energy");
  assert.ok(light);
  assert.ok(power);
  assert.ok(energy);

  assert.deepEqual(statePatchForComponent(light, {state: "ON", power: 5.4, energy: 0.2}), {power: "ON"});
  assert.deepEqual(statePatchForComponent(power, {state: "ON", power: 5.4}), {power: 5.4});
  assert.deepEqual(statePatchForComponent(energy, {state: "ON", energy: 0.2}), {energy: 0.2});
});

test("state patches route color values only to light components", () => {
  const device = normalizeDevice(bulb);
  const light = device.components.find((component) => component.id === "default-light");
  const power = device.components.find((component) => component.id === "default-power");
  assert.ok(light);
  assert.ok(power);

  assert.deepEqual(statePatchForComponent(light, {color: {x: 0.31, y: 0.33}, color_temp: 250, power: 5.4}), {color: {x: 0.31, y: 0.33}, color_temp: 250});
  assert.deepEqual(statePatchForComponent(power, {color: {x: 0.31, y: 0.33}, color_temp: 250}), {});
});
