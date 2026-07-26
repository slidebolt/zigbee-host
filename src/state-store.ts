import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import type {StateOrigin} from "./types.js";

export type DeviceState = Record<string, unknown>;

export interface PendingStateValue {
  value: unknown;
  commandId: string;
  requestedAt: string;
}

export interface DeviceStateSnapshot {
  reported: DeviceState;
  observed: Record<string, {updatedAt: string; origin: Exclude<StateOrigin, "optimistic">}>;
  pending: Record<string, PendingStateValue>;
}

interface StateFileV2 {
  version: 2;
  devices: Record<string, DeviceStateSnapshot>;
}

const empty = (): DeviceStateSnapshot => ({reported: {}, observed: {}, pending: {}});

export class StateStore {
  readonly #file: string;
  #devices: Record<string, DeviceStateSnapshot> = {};
  #pendingSave: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && (parsed as Partial<StateFileV2>).version === 2) {
        this.#devices = (parsed as StateFileV2).devices;
      } else {
        const legacy = parsed as Record<string, DeviceState>;
        const migratedAt = new Date().toISOString();
        this.#devices = Object.fromEntries(Object.entries(legacy).map(([device, reported]) => [device, {
          reported,
          observed: Object.fromEntries(Object.keys(reported).map((property) => [property, {updatedAt: migratedAt, origin: "device" as const}])),
          pending: {},
        }]));
        await this.#queueSave();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#devices = {};
    }
  }

  get(ieeeAddress: string): DeviceState {
    return {...(this.#devices[ieeeAddress]?.reported ?? {})};
  }

  snapshot(ieeeAddress: string): DeviceStateSnapshot {
    const current = this.#devices[ieeeAddress] ?? empty();
    return {reported: {...current.reported}, observed: {...current.observed}, pending: {...current.pending}};
  }

  async merge(ieeeAddress: string, payload: DeviceState, origin: Exclude<StateOrigin, "optimistic">): Promise<DeviceState> {
    const current = this.#devices[ieeeAddress] ?? empty();
    const updatedAt = new Date().toISOString();
    current.reported = {...current.reported, ...payload};
    current.observed = {...current.observed, ...Object.fromEntries(Object.keys(payload).map((property) => [property, {updatedAt, origin}]))};
    this.#devices[ieeeAddress] = current;
    await this.#queueSave();
    return {...current.reported};
  }

  async markPending(ieeeAddress: string, commandId: string, values: DeviceState, requestedAt: string): Promise<void> {
    const current = this.#devices[ieeeAddress] ?? empty();
    current.pending = {...current.pending, ...Object.fromEntries(Object.entries(values).map(([property, value]) => [property, {value, commandId, requestedAt}]))};
    this.#devices[ieeeAddress] = current;
    await this.#queueSave();
  }

  async clearPending(ieeeAddress: string, commandId: string): Promise<void> {
    const current = this.#devices[ieeeAddress];
    if (!current) return;
    current.pending = Object.fromEntries(Object.entries(current.pending).filter(([, pending]) => pending.commandId !== commandId));
    await this.#queueSave();
  }

  async #queueSave(): Promise<void> {
    this.#pendingSave = this.#pendingSave.then(() => this.#save());
    await this.#pendingSave;
  }

  async #save(): Promise<void> {
    await mkdir(path.dirname(this.#file), {recursive: true});
    const temporary = `${this.#file}.tmp`;
    const value: StateFileV2 = {version: 2, devices: this.#devices};
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, this.#file);
  }
}
