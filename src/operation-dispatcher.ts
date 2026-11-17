export type OperationPriority = "command" | "reconcile" | "background";

export interface DispatcherStatus {
  maxInFlight: number;
  maxBackgroundInFlight: number;
  active: number;
  activeBackground: number;
  foregroundQueued: number;
  backgroundQueued: number;
  superseded: number;
}

export interface DispatchOptions {
  deviceId: string;
  priority: OperationPriority;
  operationId?: string;
  replaceKey?: string;
  onDispatch?: () => void | Promise<void>;
}

interface WaitingOperation<T = unknown> {
  options: DispatchOptions;
  queuedAt: number;
  operation: () => T | Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class OperationSupersededError extends Error {
  readonly code = "operation_superseded";
  readonly phase = "send" as const;
  readonly retryable = false;

  constructor(readonly supersededBy?: string) {
    super("A newer device intent replaced this operation before transmission");
  }
}

export interface OperationDispatcherOptions {
  maxInFlight?: number;
  maxBackgroundInFlight?: number;
  output?: (event: string, data: unknown) => void;
}

/**
 * Owns access to the shared Zigbee radio. Operations are concurrent across
 * devices, strictly serialized within one device, and foreground work always
 * outranks polling. A queued state-setting operation can be replaced by a
 * newer operation for the same device/property before it reaches the radio.
 */
export class OperationDispatcher {
  readonly #commands: WaitingOperation[] = [];
  readonly #reconcile: WaitingOperation[] = [];
  readonly #background: WaitingOperation[] = [];
  readonly #activeDevices = new Set<string>();
  readonly #output: (event: string, data: unknown) => void;
  #maxInFlight: number;
  #maxBackgroundInFlight: number;
  #active = 0;
  #activeBackground = 0;
  #superseded = 0;

  constructor(options: OperationDispatcherOptions = {}) {
    this.#maxInFlight = bounded(options.maxInFlight ?? 4, 1, 16, "maxInFlight");
    this.#maxBackgroundInFlight = bounded(options.maxBackgroundInFlight ?? 1, 0, this.#maxInFlight, "maxBackgroundInFlight");
    this.#output = options.output ?? (() => undefined);
  }

  run<T>(options: DispatchOptions, operation: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiting: WaitingOperation<T> = {options: {...options, deviceId: options.deviceId.toLowerCase()}, queuedAt: Date.now(), operation, resolve, reject};
      if (options.priority === "command" && options.replaceKey) this.#supersedeQueued(waiting.options);
      (options.priority === "command" ? this.#commands : options.priority === "reconcile" ? this.#reconcile : this.#background).push(waiting as WaitingOperation);
      this.#output("dispatcher.queued", {...waiting.options, status: this.status()});
      this.#drain();
    });
  }

  configure(maxInFlight: number, maxBackgroundInFlight?: number): DispatcherStatus {
    this.#maxInFlight = bounded(maxInFlight, 1, 16, "maxInFlight");
    this.#maxBackgroundInFlight = maxBackgroundInFlight === undefined
      ? Math.min(this.#maxBackgroundInFlight, this.#maxInFlight)
      : bounded(maxBackgroundInFlight, 0, this.#maxInFlight, "maxBackgroundInFlight");
    this.#drain();
    return this.status();
  }

  status(): DispatcherStatus {
    return {
      maxInFlight: this.#maxInFlight,
      maxBackgroundInFlight: this.#maxBackgroundInFlight,
      active: this.#active,
      activeBackground: this.#activeBackground,
      foregroundQueued: this.#commands.length + this.#reconcile.length,
      backgroundQueued: this.#background.length,
      superseded: this.#superseded,
    };
  }

  #supersedeQueued(incoming: DispatchOptions): void {
    for (let index = this.#commands.length - 1; index >= 0; index--) {
      const queued = this.#commands[index]!;
      if (queued.options.deviceId !== incoming.deviceId || queued.options.replaceKey !== incoming.replaceKey) continue;
      this.#commands.splice(index, 1);
      this.#superseded++;
      queued.reject(new OperationSupersededError(incoming.operationId));
      this.#output("dispatcher.superseded", {deviceId: incoming.deviceId, replaceKey: incoming.replaceKey, operationId: queued.options.operationId, supersededBy: incoming.operationId});
    }
  }

  #drain(): void {
    while (this.#active < this.#maxInFlight) {
      const commandIndex = this.#eligibleIndex(this.#commands);
      if (commandIndex >= 0) {
        this.#start(this.#commands.splice(commandIndex, 1)[0]!);
        continue;
      }
      // A queued command waiting for its device retains priority over all
      // reads so capacity is available the moment that device is free.
      if (this.#commands.length > 0) break;
      const reconcileIndex = this.#eligibleIndex(this.#reconcile);
      if (reconcileIndex >= 0) {
        this.#start(this.#reconcile.splice(reconcileIndex, 1)[0]!);
        continue;
      }
      // Do not start new polling while foreground work is waiting for a busy
      // device. This leaves capacity available as soon as that device clears.
      if (this.#reconcile.length > 0 || this.#activeBackground >= this.#maxBackgroundInFlight) break;
      const backgroundIndex = this.#eligibleIndex(this.#background);
      if (backgroundIndex < 0) break;
      this.#start(this.#background.splice(backgroundIndex, 1)[0]!);
    }
  }

  #eligibleIndex(queue: WaitingOperation[]): number {
    return queue.findIndex((entry) => !this.#activeDevices.has(entry.options.deviceId));
  }

  #start(waiting: WaitingOperation): void {
    const background = waiting.options.priority === "background";
    this.#active++;
    if (background) this.#activeBackground++;
    this.#activeDevices.add(waiting.options.deviceId);
    const queueWaitMs = Date.now() - waiting.queuedAt;
    void Promise.resolve()
      .then(() => waiting.options.onDispatch?.())
      .then(() => {
        this.#output("dispatcher.started", {...waiting.options, queueWaitMs, status: this.status()});
        return waiting.operation();
      })
      .then(waiting.resolve, waiting.reject)
      .finally(() => {
        this.#active--;
        if (background) this.#activeBackground--;
        this.#activeDevices.delete(waiting.options.deviceId);
        this.#output("dispatcher.finished", {...waiting.options, status: this.status()});
        this.#drain();
      });
  }
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

export function parseDispatcherOptions(env: NodeJS.ProcessEnv = process.env): Pick<OperationDispatcherOptions, "maxInFlight" | "maxBackgroundInFlight"> {
  const maxInFlight = parseBounded(env.ZIGBEE_MAX_IN_FLIGHT, 4, 1, 16);
  return {
    maxInFlight,
    maxBackgroundInFlight: parseBounded(env.ZIGBEE_MAX_BACKGROUND_IN_FLIGHT, 1, 0, maxInFlight),
  };
}

function parseBounded(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number(raw ?? fallback);
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
