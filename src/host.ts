#!/usr/bin/env node
import {unlinkSync} from "node:fs";
import {unlink} from "node:fs/promises";
import process from "node:process";
import {configureLibraryLogging} from "./logging.js";
import {ensureHostToken, hostPaths} from "./host-config.js";
import {ZigbeeHost} from "./host-server.js";
import {probePort} from "./probe.js";
import {AdapterLocator} from "./adapter-locator.js";
import {runtimePaths} from "./config.js";
import {ZigbeeRuntimeManager} from "./runtime-manager.js";
import {acquireLock} from "./host-lock.js";

async function main(): Promise<void> {
  configureLibraryLogging();
  const paths = hostPaths();
  const token = await ensureHostToken(paths);
  await acquireLock(paths.lock);
  process.on("exit", () => {
    try { unlinkSync(paths.lock); } catch { /* already removed */ }
  });
  const adapterPort = process.env.ZIGBEE_ADAPTER ?? process.env.ZIGBEE_PORT ?? (process.platform === "win32" ? "COM7" : "/dev/zigbee");
  const locator = new AdapterLocator({
    preferredPort: adapterPort,
    probePreferredDirectly: process.env.ZIGBEE_ADAPTER !== undefined,
    identityFile: runtimePaths(paths.data).adapterIdentity,
    probe: probePort,
  });
  const host = new ZigbeeHost({
    token,
    paths,
    probeAdapter: probePort,
    locateAdapter: () => locator.locate(),
    runtimeFactory: (output, port) => new ZigbeeRuntimeManager({port, dataDirectory: paths.data, output}),
  });
  const stop = (): void => void host.stop().finally(() => process.exit());
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await host.start();
  } catch (error) {
    await unlink(paths.lock).catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
