import {autoDetect} from "@serialport/bindings-cpp";
import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import type {AdapterIdentity, ProbeResult} from "./types.js";

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface AdapterLocatorOptions {
  preferredPort: string;
  probePreferredDirectly?: boolean;
  identityFile: string;
  probe: (port: string) => Promise<ProbeResult>;
  listPorts?: () => Promise<PortInfo[]>;
}

export interface LocatedAdapter {
  port: string;
  probe: ProbeResult;
  identity: AdapterIdentity;
}

export class AdapterLocator {
  readonly #preferredPort: string;
  readonly #identityFile: string;
  readonly #probe: (port: string) => Promise<ProbeResult>;
  readonly #listPorts: () => Promise<PortInfo[]>;
  readonly #probePreferredDirectly: boolean;

  constructor(options: AdapterLocatorOptions) {
    this.#preferredPort = options.preferredPort;
    this.#identityFile = options.identityFile;
    this.#probe = options.probe;
    this.#listPorts = options.listPorts ?? (() => autoDetect().list());
    this.#probePreferredDirectly = options.probePreferredDirectly ?? false;
  }

  async locate(): Promise<LocatedAdapter> {
    const identity = await this.#loadIdentity();
    const failures: string[] = [];
    if (this.#probePreferredDirectly) {
      const direct = await this.#tryCandidate({path: this.#preferredPort}, identity, failures);
      if (direct) return direct;
    }
    let ports: PortInfo[];
    try {
      ports = await this.#listPorts();
    } catch (error) {
      failures.push(`serial port enumeration: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(failures.join("; "));
    }
    const preferred = identity?.lastPort ?? this.#preferredPort;
    const candidates = ports
      .filter((port) => port.path.toLowerCase() === preferred.toLowerCase() || (identity ? fingerprintMatches(port, identity) : false))
      .sort((left, right) => left.path.toLowerCase() === preferred.toLowerCase() ? -1 : right.path.toLowerCase() === preferred.toLowerCase() ? 1 : 0);
    if (candidates.length === 0) {
      const absent = identity ? `Coordinator ${identity.eui64} is not present on a matching serial port` : `Configured coordinator port ${this.#preferredPort} is not present`;
      throw new Error([...failures, absent].join("; "));
    }

    for (const candidate of candidates) {
      if (this.#probePreferredDirectly && candidate.path.toLowerCase() === this.#preferredPort.toLowerCase()) continue;
      const located = await this.#tryCandidate(candidate, identity, failures);
      if (located) return located;
    }
    throw new Error(failures.join("; "));
  }

  async #tryCandidate(candidate: PortInfo, identity: AdapterIdentity | undefined, failures: string[]): Promise<LocatedAdapter | undefined> {
    try {
      const probe = await this.#probe(candidate.path);
      if (identity && probe.eui64.toLowerCase() !== identity.eui64.toLowerCase()) {
        failures.push(`${candidate.path} has coordinator ${probe.eui64}, expected ${identity.eui64}`);
        return undefined;
      }
      const next: AdapterIdentity = {
        ...(identity ?? {}),
        eui64: probe.eui64,
        lastPort: candidate.path,
        ...(candidate.manufacturer ? {manufacturer: candidate.manufacturer} : {}),
        ...(candidate.serialNumber ? {serialNumber: candidate.serialNumber} : {}),
        ...(candidate.vendorId ? {vendorId: candidate.vendorId} : {}),
        ...(candidate.productId ? {productId: candidate.productId} : {}),
      };
      await this.#saveIdentity(next);
      return {port: candidate.path, probe, identity: next};
    } catch (error) {
      failures.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async #loadIdentity(): Promise<AdapterIdentity | undefined> {
    try {
      return JSON.parse(await readFile(this.#identityFile, "utf8")) as AdapterIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #saveIdentity(identity: AdapterIdentity): Promise<void> {
    await mkdir(path.dirname(this.#identityFile), {recursive: true});
    const temporary = `${this.#identityFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    await rename(temporary, this.#identityFile);
  }
}

export function fingerprintMatches(port: PortInfo, identity: AdapterIdentity): boolean {
  if (identity.serialNumber && port.serialNumber) return identity.serialNumber.toLowerCase() === port.serialNumber.toLowerCase();
  return Boolean(identity.vendorId && identity.productId && port.vendorId && port.productId
    && identity.vendorId.toLowerCase() === port.vendorId.toLowerCase()
    && identity.productId.toLowerCase() === port.productId.toLowerCase()
    && (!identity.manufacturer || !port.manufacturer || identity.manufacturer.toLowerCase() === port.manufacturer.toLowerCase()));
}
