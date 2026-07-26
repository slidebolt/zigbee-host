import {randomBytes} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

export const HOST_ADDRESS = process.env.ZIGBEE_HOST_ADDRESS ?? "127.0.0.1";
export const HOST_PORT = Number(process.env.ZIGBEE_HOST_PORT ?? 47831);

export interface HostPaths {
  runtime: string;
  token: string;
  status: string;
  lock: string;
  logs: string;
  data: string;
}

export function hostPaths(root = process.cwd()): HostPaths {
  const runtime = path.resolve(root, process.env.ZIGBEE_RUNTIME_DIR ?? "runtime");
  return {
    runtime,
    token: path.join(runtime, "host-token"),
    status: path.join(runtime, "host.json"),
    lock: path.join(runtime, "host.lock"),
    logs: path.resolve(process.env.ZIGBEE_LOG_DIR ?? path.join(root, "logs")),
    data: path.resolve(process.env.ZIGBEE_DATA_DIR ?? path.join(root, "data")),
  };
}

export async function ensureHostToken(paths: HostPaths): Promise<string> {
  await mkdir(paths.runtime, {recursive: true});
  const configured = process.env.ZIGBEE_HOST_TOKEN?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ZIGBEE_HOST_TOKEN is required in production");
  }
  try {
    return (await readFile(paths.token, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile(paths.token, `${token}\n`, {encoding: "utf8", mode: 0o600, flag: "wx"});
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await readFile(paths.token, "utf8")).trim();
  }
}
