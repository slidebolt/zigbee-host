import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {HostEventHub, redactLogSecrets, renderNarrative, type HostEvent} from "./observability.js";

function event(type: string, data: unknown): HostEvent {
  return {version: 1, id: 1, timestamp: "2026-07-25T22:14:10.000Z", category: "connection", type, data};
}

test("narrative logging explains discovery, identity, and progress", () => {
  assert.match(renderNarrative(event("join_wait_progress", {remainingSeconds: 175, phase: "waiting"}))[0]!, /Still listening.*175s/);
  assert.match(renderNarrative(event("device_joined", {ieeeAddress: "0x1234", networkAddress: 42}))[0]!, /Device announced itself: 0x1234/);
  const definition = renderNarrative(event("definition_resolved", {vendor: "Sengled", model: "E11-N1EA", description: "Element plus color", capabilities: ["state", "brightness"]}));
  assert.match(definition[0]!, /Matched Sengled E11-N1EA/);
  assert.match(definition[1]!, /state, brightness/);
  assert.match(renderNarrative(event("watch_heartbeat", {secondsSinceLastEvent: 10}))[0]!, /Watch is active; 10s/);
});

test("log redaction recursively removes control and Zigbee secrets", () => {
  assert.deepEqual(redactLogSecrets({authorization: "Bearer secret", nested: {networkKey: [1], safe: true}}), {
    authorization: "[REDACTED]",
    nested: {networkKey: "[REDACTED]", safe: true},
  });
});

test("event journal replays retained events and expires old cursors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zigbee-events-"));
  const hub = await HostEventHub.create(directory, 2);
  try {
    hub.emit("device.upserted", {id: "one"});
    hub.emit("component.state_changed", {value: 1});
    hub.emit("component.state_changed", {value: 2});
    assert.equal(hub.sequence, 3);
    assert.deepEqual(hub.replay(1)?.map((item) => item.id), [2, 3]);
    assert.equal(hub.replay(0), undefined);
    assert.ok(hub.streamId.length > 10);
  } finally {
    await hub.close();
    await rm(directory, {recursive: true, force: true});
  }
});
