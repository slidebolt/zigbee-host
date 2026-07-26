import {randomBytes} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import type {NetworkFile, RuntimePaths} from "./types.js";

export const DEFAULT_PORT = process.env.ZIGBEE_PORT ?? "COM7";
export const DEFAULT_CHANNEL = 20;

export function runtimePaths(root = path.resolve(process.env.ZIGBEE_DATA_DIR ?? "data")): RuntimePaths {
  return {
    root,
    network: path.join(root, "network.json"),
    database: path.join(root, "devices.db"),
    databaseBackup: path.join(root, "devices.db.backup"),
    coordinatorBackup: path.join(root, "coordinator-backup.json"),
    state: path.join(root, "state.json"),
    commands: path.join(root, "commands.json"),
    adapterIdentity: path.join(root, "adapter.json"),
    deviceCatalog: path.join(root, "device-catalog.json"),
  };
}

function createNetwork(): NetworkFile {
  const panBytes = randomBytes(2);
  let panID = panBytes.readUInt16LE(0);
  if (panID === 0 || panID === 0xffff) panID = 0x1a62;

  return {
    panID,
    extendedPanID: [...randomBytes(8)],
    networkKey: [...randomBytes(16)],
    channelList: [DEFAULT_CHANNEL],
  };
}

export function validateNetwork(value: unknown): NetworkFile {
  if (!value || typeof value !== "object") throw new Error("Network configuration must be an object");
  const network = value as Partial<NetworkFile>;
  if (!Number.isInteger(network.panID) || network.panID! < 1 || network.panID! >= 0xffff) {
    throw new Error("network.json has an invalid panID");
  }
  if (!Array.isArray(network.extendedPanID) || network.extendedPanID.length !== 8) {
    throw new Error("network.json must contain an 8-byte extendedPanID");
  }
  if (!Array.isArray(network.networkKey) || network.networkKey.length !== 16) {
    throw new Error("network.json must contain a 16-byte networkKey");
  }
  if (!Array.isArray(network.channelList) || network.channelList.length !== 1 || network.channelList[0]! < 11 || network.channelList[0]! > 26) {
    throw new Error("network.json must contain one Zigbee channel from 11 through 26");
  }
  for (const bytes of [network.extendedPanID, network.networkKey]) {
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error("network.json contains an invalid byte");
    }
  }
  return network as NetworkFile;
}

export async function loadOrCreateNetwork(paths: RuntimePaths): Promise<{network: NetworkFile; created: boolean}> {
  await mkdir(paths.root, {recursive: true});
  try {
    return {network: validateNetwork(JSON.parse(await readFile(paths.network, "utf8"))), created: false};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const network = createNetwork();
  await writeFile(paths.network, `${JSON.stringify(network, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  return {network, created: true};
}
