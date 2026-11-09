import type {DeviceInfo} from "./types.js";

const ACCESS_GET = 0b100;
const TICK_MS = 1_000;
const MIN_BACKOFF_MS = 60_000;

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
  /** Consecutive failed reads before a device is treated as unreachable and backed off. */
  failThreshold: number;
  /** Upper bound for the retry spacing of an unreachable device. */
  unreachableMaxMs: number;
  deviceIds?: Set<string>;
}

export interface ZigbeeWarmLoopOptions extends WarmLoopOptions {
  port: WarmLoopPort;
  output?: (event: string, data: unknown) => void;
  /** Injected clock for tests. */
  now?: () => number;
  /** Injected randomness for tests (0 <= value < 1). */
  random?: () => number;
}

export function parseWarmLoopOptions(env: NodeJS.ProcessEnv = process.env): WarmLoopOptions {
  const enabled = ["1", "true", "yes", "on"].includes((env.ZIGBEE_WARM_ENABLED ?? "").toLowerCase());
  const intervalSeconds = boundedNumber(env.ZIGBEE_WARM_INTERVAL_SECONDS, 30, 5, 3_600);
  const jitterMs = boundedNumber(env.ZIGBEE_WARM_JITTER_MS, 2_000, 0, 60_000);
  const concurrency = boundedNumber(env.ZIGBEE_WARM_CONCURRENCY, 2, 1, 8);
  const slowReadMs = boundedNumber(env.ZIGBEE_WARM_SLOW_READ_MS, 500, 100, 60_000);
  const failThreshold = boundedNumber(env.ZIGBEE_WARM_FAIL_THRESHOLD, 2, 1, 20);
  const unreachableMaxSeconds = boundedNumber(env.ZIGBEE_WARM_UNREACHABLE_MAX_SECONDS, 900, 60, 86_400);
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
    failThreshold,
    unreachableMaxMs: unreachableMaxSeconds * 1_000,
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

/**
 * Retry spacing for a device after `failures` consecutive failed reads.
 * Below the threshold the device keeps its normal interval; from the threshold
 * on it backs off, doubling from max(interval, 60 s) up to unreachableMaxMs.
 */
export function retryDelayMs(failures: number, options: Pick<WarmLoopOptions, "intervalMs" | "failThreshold" | "unreachableMaxMs">): number {
  if (failures < options.failThreshold) return options.intervalMs;
  const base = Math.max(options.intervalMs, MIN_BACKOFF_MS);
  const steps = Math.min(30, failures - options.failThreshold);
  return Math.min(Math.max(options.unreachableMaxMs, base), base * 2 ** steps);
}

interface TargetState {
  target: WarmTarget;
  nextDueAt: number;
  failures: number;
}

/**
 * Periodically reads one light property from every Zigbee light so bulbs that
 * do not report their own changes stay fresh and disappearances are noticed.
 * Each device has its own schedule: answering devices are read every interval,
 * devices that keep failing are retried with backoff so they cannot occupy the
 * limited read slots, and any sign of life (see noteSeen) puts a device back on
 * the normal schedule.
 */
export class ZigbeeWarmLoop {
  readonly #port: WarmLoopPort;
  readonly #output: (event: string, data: unknown) => void;
  readonly #options: WarmLoopOptions;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #targets = new Map<string, TargetState>();
  readonly #inFlight = new Set<string>();
  #timer?: NodeJS.Timeout;
  #stopped = true;
  #nextRefreshAt = 0;

  constructor(options: ZigbeeWarmLoopOptions) {
    this.#port = options.port;
    this.#output = options.output ?? (() => undefined);
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  start(): void {
    if (!this.#options.enabled || this.#options.intervalMs <= 0 || !this.#stopped) return;
    this.#stopped = false;
    this.#output("zigbee_warm.started", {
      intervalMs: this.#options.intervalMs,
      jitterMs: this.#options.jitterMs,
      concurrency: this.#options.concurrency,
      slowReadMs: this.#options.slowReadMs,
      failThreshold: this.#options.failThreshold,
      unreachableMaxMs: this.#options.unreachableMaxMs,
      property: this.#options.property,
      devices: this.#options.deviceIds ? [...this.#options.deviceIds] : "all",
    });
    this.#schedule(TICK_MS);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#output("zigbee_warm.stopped", {});
  }

  /** A device showed signs of life outside the loop: return it to the normal schedule. */
  noteSeen(deviceId: string): void {
    const id = deviceId.toLowerCase();
    const latest = this.#now() + this.#options.intervalMs;
    for (const state of this.#targets.values()) {
      if (state.target.deviceId !== id) continue;
      if (state.failures >= this.#options.failThreshold) this.#output("zigbee_warm.read.recovered", {...state.target, failures: state.failures, via: "seen"});
      state.failures = 0;
      state.nextDueAt = Math.min(state.nextDueAt, latest);
    }
  }

  /** One scheduling pass: refresh the target list when due, then launch due reads. Exposed for tests. */
  async tick(): Promise<void> {
    const now = this.#now();
    if (now >= this.#nextRefreshAt) {
      this.#nextRefreshAt = now + this.#options.intervalMs;
      try {
        this.#syncTargets(selectWarmTargets(await this.#port.listDevices(), this.#options), now);
      } catch (error) {
        this.#output("zigbee_warm.sweep.failed", {count: this.#targets.size, error: error instanceof Error ? error.message : String(error)});
      }
    }
    const due = [...this.#targets.entries()]
      .filter(([key, state]) => state.nextDueAt <= now && !this.#inFlight.has(key))
      .sort(([, a], [, b]) => a.nextDueAt - b.nextDueAt);
    for (const [key, state] of due) {
      if (this.#inFlight.size >= this.#options.concurrency) break;
      this.#launchRead(key, state);
    }
  }

  /** Snapshot of the per-device schedule, for diagnostics and tests. */
  schedule(): Array<WarmTarget & {nextDueAt: number; failures: number; inFlight: boolean}> {
    return [...this.#targets.entries()].map(([key, state]) => ({...state.target, nextDueAt: state.nextDueAt, failures: state.failures, inFlight: this.#inFlight.has(key)}));
  }

  #syncTargets(targets: WarmTarget[], now: number): void {
    const keys = new Set(targets.map(targetKey));
    for (const key of this.#targets.keys()) if (!keys.has(key)) this.#targets.delete(key);
    const added = targets.filter((target) => !this.#targets.has(targetKey(target)));
    // Spread newly seen devices across one interval instead of reading them all at once.
    const spacing = Math.floor(this.#options.intervalMs / Math.max(1, added.length));
    added.forEach((target, index) => {
      this.#targets.set(targetKey(target), {target, nextDueAt: now + index * spacing + this.#jitter(), failures: 0});
    });
    if (added.length > 0) this.#output("zigbee_warm.targets", {count: this.#targets.size, added: added.length});
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => this.#schedule(TICK_MS));
    }, delayMs);
  }

  #launchRead(key: string, state: TargetState): void {
    const target = state.target;
    const started = this.#now();
    this.#inFlight.add(key);
    this.#output("zigbee_warm.read.start", target);
    const slow = setTimeout(() => {
      if (this.#inFlight.has(key)) this.#output("zigbee_warm.read.pending", {...target, durationMs: this.#now() - started, slowReadMs: this.#options.slowReadMs});
    }, this.#options.slowReadMs);
    void this.#port.get(target.deviceId, target.property, target.endpoint)
      .then((values) => {
        if (state.failures >= this.#options.failThreshold) this.#output("zigbee_warm.read.recovered", {...target, failures: state.failures, via: "read"});
        state.failures = 0;
        state.nextDueAt = this.#now() + this.#options.intervalMs + this.#jitter();
        this.#output("zigbee_warm.read.done", {...target, durationMs: this.#now() - started, values});
      })
      .catch((error: unknown) => {
        state.failures += 1;
        const delay = retryDelayMs(state.failures, this.#options);
        state.nextDueAt = this.#now() + delay + this.#jitter();
        this.#output("zigbee_warm.read.failed", {
          ...target,
          durationMs: this.#now() - started,
          failures: state.failures,
          // True exactly once per outage: the read that crossed the threshold.
          unreachable: state.failures === this.#options.failThreshold,
          retryInMs: delay,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        clearTimeout(slow);
        this.#inFlight.delete(key);
      });
  }

  #jitter(): number {
    return this.#options.jitterMs <= 0 ? 0 : Math.floor(this.#random() * this.#options.jitterMs);
  }
}

function boundedNumber(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function targetKey(target: WarmTarget): string {
  return `${target.deviceId}:${target.property}:${target.endpoint ?? ""}`;
}
