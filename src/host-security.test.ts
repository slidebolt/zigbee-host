import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {ensureHostToken, hostPaths} from "./host-config.js";
import {isAuthorized} from "./host-server.js";

test("host bearer token is stable, random, and required exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-host-token-"));
  try {
    const paths = hostPaths(root);
    const first = await ensureHostToken(paths);
    const second = await ensureHostToken(paths);
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(isAuthorized(undefined, first), false);
    assert.equal(isAuthorized(`Bearer ${first}`, first), true);
    assert.equal(isAuthorized(`bearer ${first}`, first), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
