import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import type {DeviceInfo} from "./types.js";

export class DeviceCatalog {
  readonly #file: string;
  #devices = new Map<string, DeviceInfo>();

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<void> {
    try {
      const devices = JSON.parse(await readFile(this.#file, "utf8")) as DeviceInfo[];
      this.#devices = new Map(devices.map((device) => [device.ieeeAddress.toLowerCase(), device]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): DeviceInfo[] {
    return [...this.#devices.values()].map((device) => structuredClone(device));
  }

  get(id: string): DeviceInfo | undefined {
    const device = this.#devices.get(id.toLowerCase());
    return device ? structuredClone(device) : undefined;
  }

  async replace(devices: DeviceInfo[]): Promise<void> {
    this.#devices = new Map(devices.map((device) => [device.ieeeAddress.toLowerCase(), structuredClone(device)]));
    await this.#persist();
  }

  async markAllUnknown(reason: string): Promise<void> {
    for (const [id, device] of this.#devices) {
      this.#devices.set(id, {...device, reachability: {...(device.reachability ?? {status: "unknown"}), status: "unknown", reason}});
    }
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await mkdir(path.dirname(this.#file), {recursive: true});
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, "utf8");
    await rename(temporary, this.#file);
  }
}
