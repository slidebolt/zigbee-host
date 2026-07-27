import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {acquireLock, type ProcessInfo, type ProcessInspector} from "./host-lock.js";

function inspector(processes: Map<number, ProcessInfo>): ProcessInspector {
  return {
    currentPid: () => 9001,
    currentStartTick: async () => "current-start",
    inspect: async (pid) => processes.get(pid) ?? null,
  };
}

async function withTempLock(fn: (lock: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-host-lock-"));
  try {
    await fn(path.join(root, "host.lock"));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

test("replaces legacy numeric lock for a missing process", async () => {
  await withTempLock(async (lock) => {
    await writeFile(lock, "123\n", "utf8");
    await acquireLock(lock, inspector(new Map()));
    const saved = JSON.parse(await readFile(lock, "utf8")) as {pid: number; startTick: string};
    assert.equal(saved.pid, 9001);
    assert.equal(saved.startTick, "current-start");
  });
});

test("replaces legacy numeric lock for an unrelated live process", async () => {
  await withTempLock(async (lock) => {
    await writeFile(lock, "123\n", "utf8");
    await acquireLock(lock, inspector(new Map([[123, {startTick: "old-start", argv: ["node", "dist/index.js"]}]])));
    const saved = JSON.parse(await readFile(lock, "utf8")) as {pid: number};
    assert.equal(saved.pid, 9001);
  });
});

test("replaces legacy numeric lock when the container reuses the same pid for the new host", async () => {
  await withTempLock(async (lock) => {
    await writeFile(lock, "9001\n", "utf8");
    await acquireLock(lock, inspector(new Map([[9001, {startTick: "current-start", argv: ["node", "/app/zigbee-host/dist/host.js"]}]])));
    const saved = JSON.parse(await readFile(lock, "utf8")) as {pid: number; startTick: string};
    assert.equal(saved.pid, 9001);
    assert.equal(saved.startTick, "current-start");
  });
});

test("rejects legacy numeric lock for a live Zigbee host process", async () => {
  await withTempLock(async (lock) => {
    await writeFile(lock, "123\n", "utf8");
    await assert.rejects(
      acquireLock(lock, inspector(new Map([[123, {startTick: "old-start", argv: ["node", "/app/zigbee-host/dist/host.js"]}]]))),
      /Zigbee host is already running as PID 123/,
    );
  });
});

test("rejects structured lock for the same live Zigbee host process generation", async () => {
  await withTempLock(async (lock) => {
    await writeFile(lock, `${JSON.stringify({pid: 123, startedAt: "2026-07-26T00:00:00.000Z", startTick: "same-start", argv: ["node", "dist/host.js"]})}\n`, "utf8");
    await assert.rejects(
      acquireLock(lock, inspector(new Map([[123, {startTick: "same-start", argv: ["node", "/app/zigbee-host/dist/host.js"]}]]))),
      /Zigbee host is already running as PID 123/,
    );
  });
});

test("replaces structured lock when pid was reused by a different process generation", async () => {
  await withTempLock(async (lock) => {
    await writeFile(lock, `${JSON.stringify({pid: 123, startedAt: "2026-07-26T00:00:00.000Z", startTick: "old-start", argv: ["node", "dist/host.js"]})}\n`, "utf8");
    await acquireLock(lock, inspector(new Map([[123, {startTick: "new-start", argv: ["node", "/app/zigbee-host/dist/host.js"]}]])));
    const saved = JSON.parse(await readFile(lock, "utf8")) as {pid: number; startTick: string};
    assert.equal(saved.pid, 9001);
    assert.equal(saved.startTick, "current-start");
  });
});
