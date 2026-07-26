import {randomUUID} from "node:crypto";
import type {DeviceStateSnapshot} from "./state-store.js";
import {CommandStore} from "./command-store.js";
import type {CommandPropertyResult, DeviceCommand, DeviceInfo, SetResult, StateEvent} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const ACCESS_STATE = 0b001;
const ACCESS_SET = 0b010;
const ACCESS_GET = 0b100;

export interface CommandDevicePort {
  getDevice(deviceId: string): Promise<DeviceInfo>;
  set(deviceId: string, property: string, value: unknown, endpoint?: string): Promise<SetResult>;
  get(deviceId: string, property: string, endpoint?: string): Promise<Record<string, unknown>>;
  subscribeState(subscriber: (event: StateEvent) => void): () => void;
  markPending(deviceId: string, commandId: string, values: Record<string, unknown>, requestedAt: string): Promise<void>;
  clearPending(deviceId: string, commandId: string): Promise<void>;
  getStateSnapshot(deviceId: string): Promise<DeviceStateSnapshot>;
}

export interface CommandEngineOptions {
  port: CommandDevicePort;
  storeFile: string;
  output?: (event: string, data: unknown) => void;
  retentionMs?: number;
  valueMatcher?: (context: {device: DeviceInfo; property: string; actual: unknown; expected: unknown}) => boolean | undefined;
}

export class DeviceCommandEngine {
  readonly #port: CommandDevicePort;
  readonly #store: CommandStore;
  readonly #output: (event: string, data: unknown) => void;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #valueMatcher?: CommandEngineOptions["valueMatcher"];
  #abort = new AbortController();
  #stopping = false;

  constructor(options: CommandEngineOptions) {
    this.#port = options.port;
    this.#store = new CommandStore(options.storeFile, options.retentionMs);
    this.#output = options.output ?? (() => undefined);
    this.#valueMatcher = options.valueMatcher;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
    for (const command of await this.#store.load()) {
      await this.#port.clearPending(command.deviceId, command.id).catch(() => undefined);
      this.#emit(command);
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#abort.abort();
    await Promise.allSettled([...this.#queues.values()]);
  }

  async submit(deviceId: string, requested: Record<string, unknown>, observationTimeoutMs = DEFAULT_TIMEOUT_MS, endpoints?: Record<string, string>): Promise<DeviceCommand> {
    if (!Number.isInteger(observationTimeoutMs) || observationTimeoutMs < 1_000 || observationTimeoutMs > 300_000) {
      throw new Error("observationTimeoutMs must be an integer from 1000 through 300000");
    }
    const device = await this.#port.getDevice(deviceId);
    for (const property of Object.keys(requested)) {
      if (!device.exposes.some((expose) => expose.property === property && (endpoints?.[property] === undefined || expose.endpoint === endpoints[property]) && (expose.access & ACCESS_SET) !== 0)) {
        throw new Error(`Device '${device.definition?.model ?? device.modelID}' does not expose '${property}' for set`);
      }
    }
    const now = new Date().toISOString();
    const command: DeviceCommand = {
      id: `cmd_${randomUUID()}`,
      deviceId,
      status: "queued",
      requested: structuredClone(requested),
      ...(endpoints && Object.keys(endpoints).length > 0 ? {endpoints: structuredClone(endpoints)} : {}),
      results: {},
      observationTimeoutMs,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.put(command);
    const pending = Object.fromEntries(Object.entries(requested).map(([property, value]) => [stateProperty(property, endpoints?.[property]), value]));
    await this.#port.markPending(deviceId, command.id, pending, now);
    this.#emit(command);
    const previous = this.#queues.get(deviceId) ?? Promise.resolve();
    const execution = previous.catch(() => undefined).then(() => this.#execute(command.id));
    this.#queues.set(deviceId, execution);
    void execution.finally(() => {
      if (this.#queues.get(deviceId) === execution) this.#queues.delete(deviceId);
    });
    return this.#store.get(command.id)!;
  }

  get(id: string): DeviceCommand | undefined {
    return this.#store.get(id);
  }

  list(filters?: {deviceId?: string; status?: string; limit?: number}): DeviceCommand[] {
    return this.#store.list(filters);
  }

  async #execute(id: string): Promise<void> {
    const command = this.#store.get(id);
    if (!command) return;
    let pendingCleared = false;
    try {
      await this.#transition(command, "sending", {sendingAt: new Date().toISOString()});
      const device = await this.#port.getDevice(command.deviceId);
      let terminal: DeviceCommand["status"] = "confirmed";
      for (const [property, requested] of Object.entries(command.requested)) {
        const endpoint = command.endpoints?.[property];
        const expose = device.exposes.find((candidate) => candidate.property === property && (endpoint === undefined || candidate.endpoint === endpoint) && (candidate.access & ACCESS_SET) !== 0)!;
        const observable = (expose.access & (ACCESS_STATE | ACCESS_GET)) !== 0;
        let expected: unknown = requested;
        let observation: Promise<StateEvent> | undefined;
        let resolveObservation: ((event: StateEvent) => void) | undefined;
        const buffered: StateEvent[] = [];
        let unsubscribe: (() => void) | undefined;
        if (observable) {
          observation = new Promise<StateEvent>((resolve) => { resolveObservation = resolve; });
          unsubscribe = this.#port.subscribeState((event) => {
            const actual = eventValue(event, property, endpoint);
            if (event.origin === "optimistic" || event.device.toLowerCase() !== command.deviceId || actual === undefined) return;
            buffered.push(event);
            if (this.#matches(device, property, actual, expected, expose.valueStep)) resolveObservation?.(event);
          });
        }
        try {
          const sent: SetResult = await this.#port.set(command.deviceId, property, requested, endpoint);
          command.expected = {...command.expected, ...sent.expected};
          expected = Object.hasOwn(sent.expected, property) ? sent.expected[property] : requested;
          for (const event of buffered) {
            if (this.#matches(device, property, eventValue(event, property, endpoint), expected, expose.valueStep)) resolveObservation?.(event);
          }
          command.sentAt = new Date().toISOString();
          if (!observable || !observation) {
            command.results[property] = {status: "unverifiable", requested, expected, detail: "The property cannot be read or observed"};
            if (terminal === "confirmed") terminal = "unverifiable";
            continue;
          }
          await this.#transition(command, "observing", {sentAt: command.sentAt});
          const result = await this.#observe(command, property, requested, expected, observation, (expose.access & ACCESS_GET) !== 0, endpoint);
          command.results[property] = result;
          if (result.status === "inconclusive") terminal = "inconclusive";
          else if (result.status === "unverifiable" && terminal === "confirmed") terminal = "unverifiable";
          for (const [effectProperty, effectExpected] of Object.entries(sent.expected)) {
            if (effectProperty === property || Object.hasOwn(command.results, effectProperty)) continue;
            const effect = await this.#observeEffect(command, device, effectProperty, effectExpected, endpoint);
            command.results[effectProperty] = effect;
            if (effect.status === "inconclusive") terminal = "inconclusive";
            else if (effect.status === "unverifiable" && terminal === "confirmed") terminal = "unverifiable";
          }
        } finally {
          unsubscribe?.();
        }
      }
      await this.#port.clearPending(command.deviceId, command.id);
      pendingCleared = true;
      await this.#transition(command, terminal, {completedAt: new Date().toISOString()});
    } catch (error) {
      command.error = this.#stopping ? "The host stopped before command observation completed; the command was not resent" : error instanceof Error ? error.message : String(error);
      if (!this.#stopping && error && typeof error === "object" && "code" in error && "phase" in error) {
        const failure = error as {code: string; phase: "send" | "read" | "observe"; retryable?: boolean; message?: string};
        command.failure = {code: failure.code, phase: failure.phase, retryable: failure.retryable === true, detail: failure.message ?? command.error};
      } else if (this.#stopping) {
        command.failure = {code: "coordinator_disconnected", phase: "observe", retryable: true, detail: command.error};
      }
      await this.#port.clearPending(command.deviceId, command.id).catch(() => undefined);
      pendingCleared = true;
      await this.#transition(command, this.#stopping ? "interrupted" : "failed", {completedAt: new Date().toISOString(), error: command.error});
    } finally {
      if (!pendingCleared) await this.#port.clearPending(command.deviceId, command.id).catch(() => undefined);
    }
  }

  async #observe(command: DeviceCommand, property: string, requested: unknown, expected: unknown, observation: Promise<StateEvent>, readable: boolean, endpoint?: string): Promise<CommandPropertyResult> {
    const deadline = Date.now() + command.observationTimeoutMs;
    let poll = 0;
    const stop = abortWait(this.#abort.signal);
    try {
      while (Date.now() < deadline) {
        const delay = POLL_DELAYS_MS[Math.min(poll, POLL_DELAYS_MS.length - 1)]!;
        const event = await Promise.race([
          observation.then((value) => ({value})),
          sleep(Math.min(delay, Math.max(0, deadline - Date.now()))).then(() => undefined),
          stop.promise.then(() => { throw new Error("Command engine stopped"); }),
        ]);
        if (event) return {status: "confirmed", requested, expected, observed: eventValue(event.value, property, endpoint), origin: event.value.origin};
        if (readable) await this.#port.get(command.deviceId, property, endpoint).catch(() => undefined);
        poll++;
      }
      const final = await Promise.race([observation.then((value) => ({value})), sleep(25).then(() => undefined)]);
      if (final) return {status: "confirmed", requested, expected, observed: eventValue(final.value, property, endpoint), origin: final.value.origin};
      return {status: "inconclusive", requested, expected, detail: `No matching physical observation within ${command.observationTimeoutMs}ms`};
    } finally {
      stop.dispose();
    }
  }

  async #observeEffect(command: DeviceCommand, device: DeviceInfo, property: string, expected: unknown, endpoint?: string): Promise<CommandPropertyResult> {
    const expose = device.exposes.find((candidate) => candidate.property === property && (endpoint === undefined || candidate.endpoint === endpoint));
    if (!expose || (expose.access & (ACCESS_STATE | ACCESS_GET)) === 0) {
      return {status: "unverifiable", requested: expected, expected, detail: "The expected side effect cannot be read or observed"};
    }
    let unsubscribe = (): void => undefined;
    const observation = new Promise<StateEvent>((resolve) => {
      unsubscribe = this.#port.subscribeState((event) => {
        const actual = eventValue(event, property, endpoint);
        if (event.origin !== "optimistic" && event.device.toLowerCase() === command.deviceId && actual !== undefined
          && this.#matches(device, property, actual, expected, expose.valueStep)) resolve(event);
      });
    });
    try {
      return await this.#observe(command, property, expected, expected, observation, (expose.access & ACCESS_GET) !== 0, endpoint);
    } finally {
      unsubscribe();
    }
  }

  async #transition(command: DeviceCommand, status: DeviceCommand["status"], fields: Partial<DeviceCommand> = {}): Promise<void> {
    Object.assign(command, fields, {status, updatedAt: new Date().toISOString()});
    await this.#store.put(command);
    this.#emit(command);
  }

  #emit(command: DeviceCommand): void {
    this.#output(`command.${command.status}`, structuredClone(command));
  }

  #matches(device: DeviceInfo, property: string, actual: unknown, expected: unknown, step?: number): boolean {
    return this.#valueMatcher?.({device, property, actual, expected}) ?? valueMatches(actual, expected, step);
  }
}

function stateProperty(property: string, endpoint?: string): string { return endpoint ? `${property}_${endpoint}` : property; }
function eventValue(event: StateEvent, property: string, endpoint?: string): unknown {
  const qualified = stateProperty(property, endpoint);
  return Object.hasOwn(event.payload, qualified) ? event.payload[qualified] : event.payload[property];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortWait(signal: AbortSignal): {promise: Promise<void>; dispose: () => void} {
  let listener = (): void => undefined;
  const promise = signal.aborted ? Promise.resolve() : new Promise<void>((resolve) => {
    listener = resolve;
    signal.addEventListener("abort", listener, {once: true});
  });
  return {promise, dispose: () => signal.removeEventListener("abort", listener)};
}

export function valueMatches(actual: unknown, expected: unknown, step?: number): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    const epsilon = step === undefined ? Number.EPSILON : Math.max(Number.EPSILON, Math.abs(step) / 2);
    return Math.abs(actual - expected) <= epsilon;
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object" && !Array.isArray(actual) && !Array.isArray(expected)) {
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => valueMatches((actual as Record<string, unknown>)[key], value, step));
  }
  return Object.is(actual, expected);
}
