import type {DeviceInfo} from "./types.js";

const ACCESS_GET = 0b100;

export interface WarmLoopPort {
  listDevices(): Promise<DeviceInfo[]>;
  get(deviceId: string, property: string, endpoint?: string): Promise<Record<string, unknown>>;
}

export interface WarmTarget {
  deviceId: string;
  property: string;
  endpoint?: string;
}

export interface WarmLoopOptions {
  enabled: boolean;
  intervalMs: number;
  jitterMs: number;
  concurrency: number;
  slowReadMs: number;
  property: string;
  deviceIds?: Set<string>;
}

export interface ZigbeeWarmLoopOptions extends WarmLoopOptions {
  port: WarmLoopPort;
  output?: (event: string, data: unknown) => void;
}

export function parseWarmLoopOptions(env: NodeJS.ProcessEnv = process.env): WarmLoopOptions {
  const enabled = ["1", "true", "yes", "on"].includes((env.ZIGBEE_WARM_ENABLED ?? "").toLowerCase());
  const intervalSeconds = boundedNumber(env.ZIGBEE_WARM_INTERVAL_SECONDS, 30, 5, 3_600);
  const jitterMs = boundedNumber(env.ZIGBEE_WARM_JITTER_MS, 2_000, 0, 60_000);
  const concurrency = boundedNumber(env.ZIGBEE_WARM_CONCURRENCY, 2, 1, 8);
  const slowReadMs = boundedNumber(env.ZIGBEE_WARM_SLOW_READ_MS, 500, 100, 60_000);
  const property = (env.ZIGBEE_WARM_PROPERTY ?? "brightness").trim() || "brightness";
  const deviceIds = (env.ZIGBEE_WARM_DEVICE_IDS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled,
    intervalMs: intervalSeconds * 1_000,
    jitterMs,
    concurrency,
    slowReadMs,
    property,
    ...(deviceIds.length > 0 ? {deviceIds: new Set(deviceIds)} : {}),
  };
}

export function selectWarmTargets(devices: DeviceInfo[], options: Pick<WarmLoopOptions, "property" | "deviceIds">): WarmTarget[] {
  const property = options.property;
  return devices.flatMap((device) => {
    const deviceId = device.ieeeAddress.toLowerCase();
    if (options.deviceIds && !options.deviceIds.has(deviceId)) return [];
    const expose = device.exposes.find((candidate) =>
      candidate.property === property &&
      candidate.category === "light" &&
      (candidate.access & ACCESS_GET) !== 0
    );
    return expose ? [{deviceId, property, ...(expose.endpoint ? {endpoint: expose.endpoint} : {})}] : [];
  });
}

export class ZigbeeWarmLoop {
  readonly #port: WarmLoopPort;
  readonly #output: (event: string, data: unknown) => void;
  readonly #options: WarmLoopOptions;
  readonly #inFlight = new Set<string>();
  #timer?: NodeJS.Timeout;
  #stopped = true;

  constructor(options: ZigbeeWarmLoopOptions) {
    this.#port = options.port;
    this.#output = options.output ?? (() => undefined);
    this.#options = options;
  }

  start(): void {
    if (!this.#options.enabled || this.#options.intervalMs <= 0 || !this.#stopped) return;
    this.#stopped = false;
    this.#output("zigbee_warm.started", {
      intervalMs: this.#options.intervalMs,
      jitterMs: this.#options.jitterMs,
      concurrency: this.#options.concurrency,
      slowReadMs: this.#options.slowReadMs,
      property: this.#options.property,
      devices: this.#options.deviceIds ? [...this.#options.deviceIds] : "all",
    });
    this.#schedule(1_000 + this.#jitter());
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#output("zigbee_warm.stopped", {});
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#sweep(), delayMs);
  }

  async #sweep(): Promise<void> {
    if (this.#stopped) return;
    const started = Date.now();
    let targets: WarmTarget[] = [];
    try {
      targets = selectWarmTargets(await this.#port.listDevices(), this.#options);
      this.#output("zigbee_warm.sweep.start", {count: targets.length, property: this.#options.property, inFlight: this.#inFlight.size});
      const spacingMs = Math.max(50, Math.floor(this.#options.intervalMs / Math.max(1, targets.length)));
      let launched = 0;
      let skipped = 0;
      for (const target of targets) {
        if (this.#stopped) return;
        if (this.#launchRead(target)) launched++;
        else skipped++;
        await sleep(spacingMs);
      }
      this.#output("zigbee_warm.sweep.done", {count: targets.length, launched, skipped, inFlight: this.#inFlight.size, durationMs: Date.now() - started});
    } catch (error) {
      this.#output("zigbee_warm.sweep.failed", {count: targets.length, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error)});
    } finally {
      this.#schedule(this.#jitter());
    }
  }

  #launchRead(target: WarmTarget): boolean {
    const key = targetKey(target);
    if (this.#inFlight.has(key)) {
      this.#output("zigbee_warm.read.skipped", {...target, reason: "already_in_flight", inFlight: this.#inFlight.size});
      return false;
    }
    if (this.#inFlight.size >= this.#options.concurrency) {
      this.#output("zigbee_warm.read.skipped", {...target, reason: "concurrency_limit", inFlight: this.#inFlight.size, concurrency: this.#options.concurrency});
      return false;
    }
    const started = Date.now();
    this.#inFlight.add(key);
    this.#output("zigbee_warm.read.start", target);
    const slow = setTimeout(() => {
      if (this.#inFlight.has(key)) this.#output("zigbee_warm.read.pending", {...target, durationMs: Date.now() - started, slowReadMs: this.#options.slowReadMs});
    }, this.#options.slowReadMs);
    void this.#port.get(target.deviceId, target.property, target.endpoint)
      .then((values) => this.#output("zigbee_warm.read.done", {...target, durationMs: Date.now() - started, values}))
      .catch((error: unknown) => this.#output("zigbee_warm.read.failed", {...target, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error)}))
      .finally(() => {
        clearTimeout(slow);
        this.#inFlight.delete(key);
      });
    return true;
  }

  #jitter(): number {
    return this.#options.jitterMs <= 0 ? 0 : Math.floor(Math.random() * this.#options.jitterMs);
  }
}

function boundedNumber(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function targetKey(target: WarmTarget): string {
  return `${target.deviceId}:${target.property}:${target.endpoint ?? ""}`;
}
