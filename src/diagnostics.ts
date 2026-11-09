import {createWriteStream, type WriteStream} from "node:fs";
import {mkdir} from "node:fs/promises";
import path from "node:path";
import type {HostEvent} from "./observability.js";
import type {DeviceInfo} from "./types.js";

export interface DiagnosticLogOptions {
  enabled: boolean;
  directory: string;
  deviceIds?: Set<string>;
}

export interface DiagnosticSnapshotOptions {
  enabled: boolean;
  intervalMs: number;
  deviceIds?: Set<string>;
}

export interface DiagnosticSnapshotPort {
  listDevices(): Promise<DeviceInfo[]>;
}

const DEFAULT_SNAPSHOT_INTERVAL_MS = 300_000;
const MIN_SNAPSHOT_INTERVAL_MS = 30_000;
const MAX_SNAPSHOT_INTERVAL_MS = 3_600_000;

const DIAGNOSTIC_EVENT_TYPES = new Set([
  "device_joined",
  "device_interview",
  "device_configured",
  "device_configuration_failed",
  "device_left",
  "device_reachability",
  "state",
  "zigbee_diag.snapshot",
  "zigbee_service.get.start",
  "zigbee_service.get.done",
  "zigbee_service.convert_get.start",
  "zigbee_service.convert_get.done",
  "zigbee_service.convert_get.failed",
  "zigbee_service.set.start",
  "zigbee_service.set.done",
  "zigbee_service.convert_set.start",
  "zigbee_service.convert_set.done",
  "zigbee_service.convert_set.failed",
  "zigbee_service.message.received",
  "zigbee_service.message.converted",
  "zigbee_service.message.done",
  "zigbee_warm.started",
  "zigbee_warm.stopped",
  "zigbee_warm.sweep.start",
  "zigbee_warm.sweep.done",
  "zigbee_warm.sweep.failed",
  "zigbee_warm.read.start",
  "zigbee_warm.read.pending",
  "zigbee_warm.read.done",
  "zigbee_warm.read.failed",
  "zigbee_warm.read.skipped",
  "zigbee_warm.read.recovered",
  "zigbee_warm.targets",
]);

export function parseDeviceIdSet(value: string | undefined): Set<string> | undefined {
  const ids = (value ?? "").split(/[\s,]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  return ids.length === 0 ? undefined : new Set(ids);
}

export function parseDiagnosticLogOptions(env: NodeJS.ProcessEnv = process.env, defaultLogDirectory = "data/logs"): DiagnosticLogOptions {
  return {
    enabled: parseBoolean(env.ZIGBEE_DIAG_ENABLED),
    directory: env.ZIGBEE_DIAG_DIR || path.join(defaultLogDirectory, "diagnostics"),
    deviceIds: parseDeviceIdSet(env.ZIGBEE_DIAG_DEVICE_IDS),
  };
}

export function parseDiagnosticSnapshotOptions(env: NodeJS.ProcessEnv = process.env): DiagnosticSnapshotOptions {
  return {
    enabled: parseBoolean(env.ZIGBEE_DIAG_ENABLED),
    intervalMs: clamp(parseSeconds(env.ZIGBEE_DIAG_SNAPSHOT_INTERVAL_SECONDS, DEFAULT_SNAPSHOT_INTERVAL_MS), MIN_SNAPSHOT_INTERVAL_MS, MAX_SNAPSHOT_INTERVAL_MS),
    deviceIds: parseDeviceIdSet(env.ZIGBEE_DIAG_DEVICE_IDS),
  };
}

function parseBoolean(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function parseSeconds(value: string | undefined, fallbackMs: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : fallbackMs;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeDeviceId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().toLowerCase();
}

function eventDeviceId(event: HostEvent): string | undefined {
  const data = record(event.data);
  return normalizeDeviceId(data.deviceId ?? data.device ?? data.ieeeAddress ?? data.id);
}

function eventHasFilteredSnapshotDevice(event: HostEvent, deviceIds: Set<string>): boolean {
  const devices = record(event.data).devices;
  return Array.isArray(devices) && devices.some((item) => {
    const device = record(item);
    return deviceIds.has(String(device.id ?? device.ieeeAddress ?? "").toLowerCase());
  });
}

function statusFor(event: HostEvent): string | undefined {
  if (event.type.endsWith(".failed")) return "failed";
  if (event.type.endsWith(".done") || event.type.endsWith(".confirmed")) return "done";
  if (event.type.endsWith(".start") || event.type.endsWith(".started")) return "start";
  if (event.type.endsWith(".pending")) return "pending";
  if (event.type.endsWith(".skipped")) return "skipped";
  const reachability = record(record(event.data).reachability);
  return typeof reachability.status === "string" ? reachability.status : undefined;
}

export function diagnosticRecord(event: HostEvent): Record<string, unknown> {
  const data = record(event.data);
  const reachability = record(data.reachability);
  const lastFailure = record(reachability.lastFailure);
  return {
    version: 1,
    ts: event.timestamp,
    id: event.id,
    event: event.type,
    category: event.category,
    ...(event.requestId ? {requestId: event.requestId} : {}),
    ...(eventDeviceId(event) ? {deviceId: eventDeviceId(event)} : {}),
    ...(typeof data.property === "string" ? {property: data.property} : {}),
    ...(typeof data.endpoint === "string" ? {endpoint: data.endpoint} : {}),
    ...(typeof data.durationMs === "number" ? {durationMs: data.durationMs} : {}),
    ...(typeof data.origin === "string" ? {origin: data.origin} : {}),
    ...(typeof data.networkAddress === "number" ? {networkAddress: data.networkAddress} : {}),
    ...(typeof data.modelID === "string" ? {modelID: data.modelID} : {}),
    ...(typeof data.model === "string" ? {model: data.model} : {}),
    ...(statusFor(event) ? {status: statusFor(event)} : {}),
    ...(typeof lastFailure.code === "string" ? {failureCode: lastFailure.code} : {}),
    ...(typeof lastFailure.phase === "string" ? {failurePhase: lastFailure.phase} : {}),
    data: event.data,
  };
}

export class ZigbeeDiagnosticEventWriter {
  readonly #options: DiagnosticLogOptions;
  #stream?: WriteStream;
  #day?: string;

  constructor(options: DiagnosticLogOptions) {
    this.#options = options;
  }

  async init(): Promise<void> {
    if (this.#options.enabled) await mkdir(this.#options.directory, {recursive: true});
  }

  write(event: HostEvent): void {
    if (!this.#options.enabled || !this.#shouldRecord(event)) return;
    const day = event.timestamp.slice(0, 10);
    if (this.#day !== day) {
      if (this.#stream) this.#stream.end();
      this.#day = day;
      this.#stream = createWriteStream(path.join(this.#options.directory, `zigbee-health-${day}.jsonl`), {flags: "a"});
    }
    this.#stream!.write(`${JSON.stringify(diagnosticRecord(event))}\n`);
  }

  async close(): Promise<void> {
    if (!this.#stream) return;
    await new Promise<void>((resolve, reject) => {
      this.#stream!.once("error", reject);
      this.#stream!.end(resolve);
    });
  }

  #shouldRecord(event: HostEvent): boolean {
    if (!DIAGNOSTIC_EVENT_TYPES.has(event.type) && !event.type.startsWith("command.")) return false;
    if (!this.#options.deviceIds) return true;
    const deviceId = eventDeviceId(event);
    if (deviceId) return this.#options.deviceIds.has(deviceId);
    if (event.type === "zigbee_diag.snapshot") return eventHasFilteredSnapshotDevice(event, this.#options.deviceIds);
    return event.type.startsWith("zigbee_warm.sweep") || event.type === "zigbee_warm.started" || event.type === "zigbee_warm.stopped";
  }
}

export class ZigbeeDiagnosticSnapshotLoop {
  readonly #port: DiagnosticSnapshotPort;
  readonly #output?: (event: string, data: unknown) => void;
  readonly #options: DiagnosticSnapshotOptions;
  #timer?: NodeJS.Timeout;
  #running = false;

  constructor(options: DiagnosticSnapshotOptions & {port: DiagnosticSnapshotPort; output?: (event: string, data: unknown) => void}) {
    this.#port = options.port;
    this.#output = options.output;
    this.#options = options;
  }

  start(): void {
    if (!this.#options.enabled || this.#running) return;
    this.#running = true;
    void this.snapshot("start");
    this.#timer = setInterval(() => void this.snapshot("interval"), this.#options.intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#running = false;
  }

  async snapshot(reason: string): Promise<void> {
    if (!this.#options.enabled) return;
    try {
      const devices = (await this.#port.listDevices())
        .filter((device) => !this.#options.deviceIds || this.#options.deviceIds.has(device.ieeeAddress.toLowerCase()))
        .map((device) => ({
          id: device.ieeeAddress.toLowerCase(),
          networkAddress: device.networkAddress,
          type: device.type,
          interviewState: device.interviewState,
          manufacturerName: device.manufacturerName,
          modelID: device.modelID,
          definition: device.definition,
          reachability: device.reachability ?? {status: "unknown"},
        }));
      this.#output?.("zigbee_diag.snapshot", {reason, count: devices.length, devices});
    } catch (error) {
      this.#output?.("zigbee_diag.snapshot.failed", {reason, message: error instanceof Error ? error.message : String(error)});
    }
  }
}
