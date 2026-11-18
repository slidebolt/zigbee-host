import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import type {DeviceNetworkObservation, DeviceReachability} from "./types.js";

export class NetworkObservationStore {
  readonly #file: string;
  readonly #records = new Map<string, DeviceNetworkObservation>();
  #write = Promise.resolve();

  constructor(file: string) { this.#file = file; }

  async load(): Promise<void> {
    try {
      const decoded = JSON.parse(await readFile(this.#file, "utf8")) as Record<string, DeviceNetworkObservation>;
      for (const [id, value] of Object.entries(decoded)) this.#records.set(id.toLowerCase(), value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(id: string): DeviceNetworkObservation | undefined { return this.#records.get(id.toLowerCase()); }

  async observeAddress(id: string, role: DeviceNetworkObservation["role"], address: number, at = new Date().toISOString()): Promise<DeviceNetworkObservation> {
    const previous = this.get(id);
    if (previous?.role === role && previous.address === address) return previous;
    const changed = previous !== undefined && previous.address !== address;
    return this.#save(id, {
      ...previous, role, address,
      ...(changed ? {previousAddress: previous.address, addressChangedAt: at} : {}),
    });
  }

  async observeInbound(id: string, role: DeviceNetworkObservation["role"], address: number, linkQuality: number | undefined, at = new Date().toISOString()): Promise<DeviceNetworkObservation> {
    const previous = this.get(id);
    const changed = previous !== undefined && previous.address !== address;
    return this.#save(id, {
      ...previous, role, address,
      ...(changed ? {previousAddress: previous.address, addressChangedAt: at} : {}),
      lastInboundAt: at,
      ...(Number.isFinite(linkQuality) ? {linkQuality, linkQualityObservedAt: at} : {}),
    });
  }

  async observeOutboundSuccess(id: string, at = new Date().toISOString()): Promise<DeviceNetworkObservation | undefined> {
    const current = this.get(id);
    return current ? this.#save(id, {...current, lastOutboundSuccessAt: at}) : undefined;
  }

  async observeFailure(id: string, failure: NonNullable<DeviceReachability["lastFailure"]>): Promise<DeviceNetworkObservation | undefined> {
    const current = this.get(id);
    return current ? this.#save(id, {...current, lastFailure: failure}) : undefined;
  }

  async observeTopology(id: string, patch: Partial<DeviceNetworkObservation>, at = new Date().toISOString()): Promise<DeviceNetworkObservation | undefined> {
    const current = this.get(id);
    return current ? this.#save(id, {...current, ...patch, topologyObservedAt: at}) : undefined;
  }

  async #save(id: string, value: DeviceNetworkObservation): Promise<DeviceNetworkObservation> {
    this.#records.set(id.toLowerCase(), value);
    const serialized = `${JSON.stringify(Object.fromEntries(this.#records), null, 2)}\n`;
    this.#write = this.#write.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.#file), {recursive: true});
      const temp = `${this.#file}.tmp`;
      await writeFile(temp, serialized, "utf8");
      await rename(temp, this.#file);
    });
    await this.#write;
    return value;
  }
}
