import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {archiveDataDirectory, archiveDestination} from "./archive.js";

test("archiveDataDirectory moves runtime data into a timestamped recoverable backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-zigbee-archive-"));
  try {
    const data = path.join(root, "data");
    await mkdir(data);
    await writeFile(path.join(data, "network.json"), "secret-network", "utf8");
    const date = new Date("2026-07-25T12:34:56.789Z");
    const expected = archiveDestination(data, date);
    assert.equal(await archiveDataDirectory(data, date), expected);
    assert.equal(await readFile(path.join(expected, "network.json"), "utf8"), "secret-network");
    await assert.rejects(readFile(path.join(data, "network.json"), "utf8"), {code: "ENOENT"});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("archiveDataDirectory is a no-op when no prior data exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-zigbee-no-archive-"));
  try {
    assert.equal(await archiveDataDirectory(path.join(root, "missing")), undefined);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
