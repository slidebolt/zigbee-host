import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {StateStore} from "./state-store.js";

test("reported state and pending intent remain separate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-state-planes-"));
  try {
    const store = new StateStore(path.join(root, "state.json"));
    await store.load();
    await store.merge("device", {brightness: 242}, "read-response");
    await store.markPending("device", "cmd_1", {brightness: 40}, new Date().toISOString());
    const snapshot = store.snapshot("device");
    assert.equal(snapshot.reported.brightness, 242);
    assert.equal(snapshot.pending.brightness?.value, 40);
    assert.equal(snapshot.observed.brightness?.origin, "read-response");
    await store.clearPending("device", "cmd_1");
    assert.deepEqual(store.snapshot("device").pending, {});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
