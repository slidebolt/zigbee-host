import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {NetworkObservationStore} from "./network-observations.js";

test("network observations retain address history and packet link quality across restarts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-network-"));
  const file = path.join(root, "network-observations.json");
  const store = new NetworkObservationStore(file);
  await store.load();
  await store.observeAddress("0x1", "router", 25760, "2026-11-17T18:00:00Z");
  await store.observeInbound("0x1", "router", 26510, 147, "2026-11-17T18:01:00Z");
  await store.observeTopology("0x1", {parentId: "0x2", relationship: "child", depth: 2}, "2026-11-17T18:02:00Z");

  const restored = new NetworkObservationStore(file);
  await restored.load();
  assert.deepEqual(restored.get("0x1"), {
    role: "router", address: 26510, previousAddress: 25760, addressChangedAt: "2026-11-17T18:01:00Z",
    lastInboundAt: "2026-11-17T18:01:00Z", linkQuality: 147, linkQualityObservedAt: "2026-11-17T18:01:00Z",
    parentId: "0x2", relationship: "child", depth: 2, topologyObservedAt: "2026-11-17T18:02:00Z",
  });
  assert.doesNotMatch(await readFile(file, "utf8"), /networkKey|token|password/i);
});
