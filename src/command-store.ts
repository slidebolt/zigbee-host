import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import type {DeviceCommand} from "./types.js";

interface CommandFile {
  version: 1;
  commands: DeviceCommand[];
}

const ACTIVE = new Set(["queued", "sending", "observing"]);

export class CommandStore {
  readonly #file: string;
  readonly #retentionMs: number;
  #commands = new Map<string, DeviceCommand>();
  #pendingSave: Promise<void> = Promise.resolve();

  constructor(file: string, retentionMs = 7 * 24 * 60 * 60 * 1000) {
    this.#file = file;
    this.#retentionMs = retentionMs;
  }

  async load(): Promise<DeviceCommand[]> {
    try {
      const file = JSON.parse(await readFile(this.#file, "utf8")) as CommandFile;
      this.#commands = new Map(file.commands.map((command) => [command.id, command]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const interrupted: DeviceCommand[] = [];
    for (const command of this.#commands.values()) {
      if (ACTIVE.has(command.status)) {
        command.status = "interrupted";
        command.updatedAt = new Date().toISOString();
        command.completedAt = command.updatedAt;
        command.error = "The host restarted before command observation completed; the command was not resent";
        interrupted.push(command);
      }
    }
    this.#prune();
    await this.#saveQueued();
    return interrupted.map((command) => structuredClone(command));
  }

  get(id: string): DeviceCommand | undefined {
    const command = this.#commands.get(id);
    return command ? structuredClone(command) : undefined;
  }

  list(filters: {deviceId?: string; status?: string; limit?: number} = {}): DeviceCommand[] {
    const cutoff = Date.now() - this.#retentionMs;
    return [...this.#commands.values()]
      .filter((command) => ACTIVE.has(command.status) || Date.parse(command.completedAt ?? command.updatedAt) >= cutoff)
      .filter((command) => !filters.deviceId || command.deviceId === filters.deviceId)
      .filter((command) => !filters.status || command.status === filters.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, filters.limit ?? 100)
      .map((command) => structuredClone(command));
  }

  async put(command: DeviceCommand): Promise<void> {
    this.#pendingSave = this.#pendingSave.then(async () => {
      const proposed = new Map(this.#commands);
      proposed.set(command.id, structuredClone(command));
      this.#prune(proposed);
      await this.#save(proposed);
      this.#commands = proposed;
    });
    await this.#pendingSave;
  }

  #prune(commands = this.#commands): void {
    const cutoff = Date.now() - this.#retentionMs;
    for (const [id, command] of commands) {
      if (!ACTIVE.has(command.status) && Date.parse(command.completedAt ?? command.updatedAt) < cutoff) commands.delete(id);
    }
  }

  async #saveQueued(): Promise<void> {
    this.#pendingSave = this.#pendingSave.then(() => this.#save());
    await this.#pendingSave;
  }

  async #save(commands = this.#commands): Promise<void> {
    await mkdir(path.dirname(this.#file), {recursive: true});
    const temporary = `${this.#file}.tmp`;
    const file: CommandFile = {version: 1, commands: [...commands.values()]};
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporary, this.#file);
  }
}
