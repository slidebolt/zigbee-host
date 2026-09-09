import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {DeviceCommandEngine, type CommandDevicePort, valueMatches} from "./command-engine.js";
import {CommandStore} from "./command-store.js";
import type {DeviceCommand, DeviceInfo, StateEvent, StateOrigin} from "./types.js";

const ieeeAddress = "0x00124b0000000001";
const FOLLOW_REQUEST = Symbol("follow-request");

function device(access = 7): DeviceInfo {
  return {
    ieeeAddress, networkAddress: 1, type: "EndDevice", interviewState: "SUCCESSFUL",
    definition: {vendor: "Test", model: "test-device", description: "test", generated: false},
    exposes: [{property: "brightness", type: "numeric", access, valueMin: 0, valueMax: 254, valueStep: 1}, {property: "state", type: "enum", access: 7, values: ["ON", "OFF"]}],
  };
}

class FakePort implements CommandDevicePort {
  readonly subscribers = new Set<(event: StateEvent) => void>();
  readonly sent: unknown[] = [];
  readonly pending = new Map<string, Record<string, unknown>>();
  access = 7;
  readValue: unknown = FOLLOW_REQUEST;
  staleAfterSet?: unknown;
  lastRequested?: unknown;
  gets = 0;
  sideEffects: Record<string, unknown> = {};
  readonly values: Record<string, unknown> = {};

  async getDevice(): Promise<DeviceInfo> { return device(this.access); }
  async set(_deviceId: string, property: string, value: unknown) {
    this.sent.push(value);
    this.lastRequested = value;
    this.values[property] = value;
    Object.assign(this.values, this.sideEffects);
    this.publish(property, value, "optimistic");
    if (this.staleAfterSet !== undefined) this.publish(property, this.staleAfterSet, "read-response");
    return {state: {}, expected: {[property]: value, ...this.sideEffects}};
  }
  async get(_deviceId: string, property: string) {
    this.gets++;
    const value = property === "brightness" && this.readValue !== FOLLOW_REQUEST ? this.readValue : this.values[property] ?? this.lastRequested;
    this.publish(property, value, "read-response");
    return {[property]: value};
  }
  subscribeState(subscriber: (event: StateEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
  async markPending(_deviceId: string, commandId: string, values: Record<string, unknown>) { this.pending.set(commandId, values); }
  async clearPending(_deviceId: string, commandId: string) { this.pending.delete(commandId); }
  async getStateSnapshot() { return {reported: {}, observed: {}, pending: {}}; }
  publish(property: string, value: unknown, origin: StateOrigin): void {
    const event: StateEvent = {device: ieeeAddress, payload: {[property]: value}, state: {[property]: value}, origin};
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

async function terminal(engine: DeviceCommandEngine, id: string, timeoutMs = 3_000): Promise<DeviceCommand> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const command = engine.get(id)!;
    if (["confirmed", "unverifiable", "inconclusive", "failed", "interrupted"].includes(command.status)) return command;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("command did not reach a terminal state");
}

test("stale and optimistic values do not confirm; bounded read-back observes the final value", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-race-"));
  try {
    const port = new FakePort();
    port.staleAfterSet = 242;
    const engine = new DeviceCommandEngine({port, storeFile: path.join(root, "commands.json")});
    await engine.start();
    const queued = await engine.submit(ieeeAddress, {brightness: 40}, 1_000);
    port.publish("brightness", 242, "read-response");
    const result = await terminal(engine, queued.id);
    assert.equal(result.status, "confirmed");
    assert.equal(result.results.brightness?.observed, 40);
    assert.equal(result.results.brightness?.origin, "read-response");
    assert.equal(port.sent.length, 1, "observation retries must not resend the command");
    assert.equal(port.pending.size, 0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("commands for one device execute in FIFO order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-fifo-"));
  try {
    const port = new FakePort();
    const engine = new DeviceCommandEngine({port, storeFile: path.join(root, "commands.json")});
    await engine.start();
    const first = await engine.submit(ieeeAddress, {brightness: 10}, 1_000);
    const second = await engine.submit(ieeeAddress, {brightness: 20}, 1_000);
    assert.equal((await terminal(engine, first.id)).status, "confirmed");
    assert.equal((await terminal(engine, second.id)).status, "confirmed");
    assert.deepEqual(port.sent, [10, 20]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("converter-implied side effects are recorded without blocking physical confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-effects-"));
  try {
    const port = new FakePort();
    port.sideEffects = {state: "ON"};
    const engine = new DeviceCommandEngine({port, storeFile: path.join(root, "commands.json")});
    await engine.start();
    const queued = await engine.submit(ieeeAddress, {brightness: 12}, 1_500);
    const result = await terminal(engine, queued.id, 4_000);
    assert.equal(result.status, "confirmed");
    assert.deepEqual(result.expected, {brightness: 12, state: "ON"});
    assert.equal(result.results.brightness?.status, "confirmed");
    assert.equal(result.results.state?.status, "unverifiable");
    assert.equal(result.results.state?.expected, "ON");
    assert.match(result.results.state?.detail ?? "", /critical path/);
    assert.ok(result.timeline?.["effect.state.skipped"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("command lifecycle output includes pending, physical send, and observation phases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-lifecycle-"));
  try {
    const port = new FakePort();
    const events: string[] = [];
    const engine = new DeviceCommandEngine({port, storeFile: path.join(root, "commands.json"), output: (event) => events.push(event)});
    await engine.start();
    const queued = await engine.submit(ieeeAddress, {brightness: 44}, 1_000);
    assert.equal((await terminal(engine, queued.id)).status, "confirmed");
    assert.ok(events.includes("command.pending_marked"));
    assert.ok(events.includes("command.queued"));
    assert.ok(events.includes("command.sending"));
    assert.ok(events.includes("command.physical_send.start"));
    assert.ok(events.includes("command.physical_send.done"));
    assert.ok(events.includes("command.observing"));
    assert.ok(events.includes("command.observe.brightness.start"));
    assert.ok(events.includes("command.observe.brightness.wait.0.start"));
    assert.ok(events.includes("command.observe.brightness.read.0.start"));
    assert.ok(events.includes("command.observe.brightness.read.0.done"));
    assert.ok(events.includes("command.observe.brightness.matched"));
    assert.ok(events.includes("command.confirmed"));
    const result = await terminal(engine, queued.id);
    assert.ok(result.timeline?.["observe.brightness.start"]);
    assert.ok(result.timeline?.["observe.brightness.wait.0.start"]);
    assert.ok(result.timeline?.["observe.brightness.read.0.start"]);
    assert.ok(result.timeline?.["observe.brightness.read.0.done"]);
    assert.ok(result.timeline?.["observe.brightness.matched"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("write-only properties finish as unverifiable without pretending optimistic state is physical", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-write-only-"));
  try {
    const port = new FakePort();
    port.access = 2;
    const engine = new DeviceCommandEngine({port, storeFile: path.join(root, "commands.json")});
    await engine.start();
    const queued = await engine.submit(ieeeAddress, {brightness: 40}, 1_000);
    const result = await terminal(engine, queued.id);
    assert.equal(result.status, "unverifiable");
    assert.equal(result.results.brightness?.status, "unverifiable");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("passive observation waits for reports without issuing active reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-passive-"));
  try {
    const port = new FakePort();
    const engine = new DeviceCommandEngine({port, storeFile: path.join(root, "commands.json")});
    await engine.start();
    const queued = await engine.submit(ieeeAddress, {brightness: 70}, 1_000, undefined, "passive");
    const result = await terminal(engine, queued.id);
    assert.equal(result.status, "inconclusive");
    assert.equal(port.gets, 0);
    assert.equal(result.timeline?.["observe.brightness.read.0.start"], undefined);
    assert.equal(result.observationMode, "passive");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("persisted active commands become interrupted on restart and are not sent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-restart-"));
  try {
    const file = path.join(root, "commands.json");
    const now = new Date().toISOString();
    const active: DeviceCommand = {id: "cmd_active", deviceId: ieeeAddress, status: "observing", requested: {brightness: 40}, results: {}, observationTimeoutMs: 30_000, createdAt: now, updatedAt: now};
    const store = new CommandStore(file);
    await store.put(active);
    const port = new FakePort();
    const engine = new DeviceCommandEngine({port, storeFile: file});
    await engine.start();
    assert.equal(engine.get(active.id)?.status, "interrupted");
    assert.equal(port.sent.length, 0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("terminal command history is pruned after the retention window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-retention-"));
  try {
    const store = new CommandStore(path.join(root, "commands.json"), 1);
    const old = new Date(Date.now() - 10_000).toISOString();
    await store.put({id: "cmd_old", deviceId: ieeeAddress, status: "confirmed", requested: {}, results: {}, observationTimeoutMs: 1_000, createdAt: old, updatedAt: old, completedAt: old});
    assert.equal(store.get("cmd_old"), undefined);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("terminal command history is capped to the newest commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-cap-"));
  try {
    const file = path.join(root, "commands.json");
    const store = new CommandStore(file, 7 * 24 * 60 * 60 * 1000, 3);
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      const completedAt = new Date(base + i).toISOString();
      await store.put({id: `cmd_${i}`, deviceId: ieeeAddress, status: "confirmed", requested: {}, results: {}, observationTimeoutMs: 1_000, createdAt: completedAt, updatedAt: completedAt, completedAt});
    }
    assert.equal(store.get("cmd_0"), undefined);
    assert.equal(store.get("cmd_1"), undefined);
    assert.deepEqual(store.list({limit: 10}).map((command) => command.id), ["cmd_4", "cmd_3", "cmd_2"]);
    const saved = JSON.parse(await readFile(file, "utf8")) as {commands: DeviceCommand[]};
    assert.deepEqual(saved.commands.map((command) => command.id), ["cmd_2", "cmd_3", "cmd_4"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("terminal command history cap preserves active commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-command-cap-active-"));
  try {
    const store = new CommandStore(path.join(root, "commands.json"), 7 * 24 * 60 * 60 * 1000, 1);
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      const completedAt = new Date(base + i).toISOString();
      await store.put({id: `cmd_terminal_${i}`, deviceId: ieeeAddress, status: "confirmed", requested: {}, results: {}, observationTimeoutMs: 1_000, createdAt: completedAt, updatedAt: completedAt, completedAt});
    }
    const activeAt = new Date(base - 60_000).toISOString();
    await store.put({id: "cmd_active", deviceId: ieeeAddress, status: "observing", requested: {brightness: 40}, results: {}, observationTimeoutMs: 30_000, createdAt: activeAt, updatedAt: activeAt});
    assert.equal(store.get("cmd_terminal_0"), undefined);
    assert.equal(store.get("cmd_terminal_1"), undefined);
    assert.equal(store.get("cmd_terminal_2")?.status, "confirmed");
    assert.equal(store.get("cmd_active")?.status, "observing");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("comparison is schema-aware for numeric steps and nested values", () => {
  assert.equal(valueMatches(20.24, 20, 0.5), true);
  assert.equal(valueMatches(20.3, 20, 0.5), false);
  assert.equal(valueMatches({position: 50, ignored: true}, {position: 50}), true);
});
