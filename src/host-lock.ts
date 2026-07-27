import path from "node:path";
import {readFile, unlink, writeFile} from "node:fs/promises";
import process from "node:process";

interface LockFile {
  pid: number;
  startedAt: string;
  startTick: string | null;
  argv: string[];
}

export interface ProcessInfo {
  startTick: string | null;
  argv: string[];
}

export interface ProcessInspector {
  currentPid(): number;
  currentStartTick(): Promise<string | null>;
  inspect(pid: number): Promise<ProcessInfo | null>;
}

const realProcessInspector: ProcessInspector = {
  currentPid: () => process.pid,
  currentStartTick: () => readProcStartTick(process.pid),
  inspect: inspectProcess,
};

async function readProcStartTick(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const endCommand = stat.lastIndexOf(") ");
    if (endCommand === -1) return null;
    const fields = stat.slice(endCommand + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

async function readProcArgv(pid: number): Promise<string[]> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`);
    return cmdline.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

async function inspectProcess(pid: number): Promise<ProcessInfo | null> {
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  return {startTick: await readProcStartTick(pid), argv: await readProcArgv(pid)};
}

function isZigbeeHostProcess(info: ProcessInfo): boolean {
  const executable = path.basename(info.argv[0] ?? "");
  if (executable !== "node" && executable !== "nodejs") return false;
  return info.argv.slice(1).some((arg) => path.basename(arg) === "host.js");
}

function parseLock(raw: string): LockFile | {legacyPid: number} | null {
  const trimmed = raw.trim();
  const legacyPid = Number(trimmed);
  if (Number.isInteger(legacyPid) && legacyPid > 0) return {legacyPid};
  try {
    const parsed = JSON.parse(trimmed) as Partial<LockFile>;
    if (!Number.isInteger(parsed.pid) || parsed.pid! <= 0) return null;
    return {
      pid: parsed.pid!,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      startTick: typeof parsed.startTick === "string" ? parsed.startTick : null,
      argv: Array.isArray(parsed.argv) && parsed.argv.every((arg) => typeof arg === "string") ? parsed.argv : [],
    };
  } catch {
    return null;
  }
}

function lockContent(pid: number, startTick: string | null): string {
  return `${JSON.stringify({pid, startedAt: new Date().toISOString(), startTick, argv: process.argv})}\n`;
}

async function activeLockOwner(lock: LockFile | {legacyPid: number}, inspector: ProcessInspector): Promise<number | null> {
  if ("legacyPid" in lock) {
    if (lock.legacyPid === inspector.currentPid()) return null;
    const info = await inspector.inspect(lock.legacyPid);
    return info && isZigbeeHostProcess(info) ? lock.legacyPid : null;
  }

  if (lock.pid === inspector.currentPid()) return null;
  const info = await inspector.inspect(lock.pid);
  if (!info) return null;
  if (lock.startTick !== null && info.startTick !== lock.startTick) return null;
  return isZigbeeHostProcess(info) ? lock.pid : null;
}

export async function acquireLock(lockPath: string, inspector = realProcessInspector): Promise<void> {
  const content = await lockContent(inspector.currentPid(), await inspector.currentStartTick());
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, content, {encoding: "utf8", flag: "wx"});
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = parseLock(await readFile(lockPath, "utf8").catch(() => ""));
      const owner = existing ? await activeLockOwner(existing, inspector) : null;
      if (owner !== null) throw new Error(`Zigbee host is already running as PID ${owner}`);
      await unlink(lockPath).catch(() => undefined);
    }
  }
  await writeFile(lockPath, content, {encoding: "utf8", flag: "wx"});
}
