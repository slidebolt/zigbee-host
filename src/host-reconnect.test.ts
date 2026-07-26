import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {hostPaths} from "./host-config.js";
import {ZigbeeHost} from "./host-server.js";
import type {ManagedZigbeeRuntime} from "./runtime-manager.js";
import type {ProbeResult} from "./types.js";

const adapter: ProbeResult = {port: "COM7", protocolVersion: 13, stackType: 2, stackVersion: 1, firmware: "8.0.2", firmwareMeta: {}, eui64: "0x00124b00000000aa", meetsRecommendedFirmware: true, supportedByHost: true};

test("host stays available while degraded and reconnects with a fresh runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-host-reconnect-"));
  const token = "test-token";
  let locateCalls = 0;
  let starts = 0;
  const generations: Array<{connected: boolean; output: (type: string, data: unknown) => void}> = [];
  let host: ZigbeeHost | undefined;
  try {
    const basePaths = hostPaths(root);
    host = new ZigbeeHost({
      token,
      paths: {...basePaths, data: path.join(root, "data"), logs: path.join(root, "logs")},
      port: 0,
      locateAdapter: async () => {
        locateCalls++;
        if (locateCalls === 1) throw new Error("adapter absent");
        return {port: "COM7", probe: adapter, identity: {eui64: adapter.eui64, lastPort: "COM7"}};
      },
      probeAdapter: async () => adapter,
      runtimeFactory: (output) => {
        const generation = {connected: false, output};
        generations.push(generation);
        return {
          connection: {get connected() { return generation.connected; }, adapterInfo: adapter, startInfo: undefined},
          gateway: {listDevices: async () => []},
          commands: {list: () => [], get: () => undefined},
          start: async () => { starts++; if (starts > 1) await new Promise((resolve) => setTimeout(resolve, 100)); generation.connected = true; return {result: "resumed", createdNetworkConfig: false, firmware: adapter.firmware, panID: 1, extendedPanID: "0x1", channel: 20, nwkUpdateID: 0}; },
          stop: async () => { generation.connected = false; },
        } as unknown as ManagedZigbeeRuntime;
      },
    });
    await host.start();
    const url = `http://127.0.0.1:${host.listeningPort}`;
    const headers = {authorization: `Bearer ${token}`};
    const initial = await (await fetch(`${url}/v1/health`, {headers})).json() as {status: string};
    assert.equal(initial.status, "degraded");
    const rejected = await fetch(`${url}/v1/devices/0x00124b0000000001/components/default-light/commands`, {method: "POST", headers: {...headers, "content-type": "application/json"}, body: JSON.stringify({action: "set_brightness", parameters: {brightness: 12}})});
    assert.equal(rejected.status, 503);
    assert.equal(((await rejected.json()) as {type: string}).type, "coordinator_reconnecting");

    const deadline = Date.now() + 3_000;
    let health: {status: string; coordinator: {state: string}} = {status: "degraded", coordinator: {state: "starting"}};
    while (Date.now() < deadline) {
      health = await (await fetch(`${url}/v1/health`, {headers})).json() as typeof health;
      if (health.status === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(health.coordinator.state, "connected");
    assert.equal(starts, 1);

    generations[0]!.connected = false;
    generations[0]!.output("adapter_disconnected", {});
    const disconnected = await (await fetch(`${url}/v1/health`, {headers})).json() as typeof health;
    assert.equal(disconnected.status, "degraded");

    while (Date.now() < deadline + 2_000 && starts < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(starts, 2);
  } finally {
    await host?.stop().catch(() => undefined);
    await rm(root, {recursive: true, force: true});
  }
});
