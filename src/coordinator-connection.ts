import type {Events, Models} from "zigbee-herdsman";
import {Controller} from "zigbee-herdsman";
import {loadOrCreateNetwork, runtimePaths} from "./config.js";
import {probePort} from "./probe.js";
import type {CoordinatorStartInfo, ProbeResult, RuntimePaths} from "./types.js";

export type CoordinatorEvent =
  | {type: "deviceJoined"; data: {device: Models.Device}}
  | {type: "deviceInterview"; data: {device: Models.Device; status: "started" | "successful" | "failed"}}
  | {type: "deviceAnnounce"; data: {device: Models.Device}}
  | {type: "deviceNetworkAddressChanged"; data: {device: Models.Device}}
  | {type: "deviceLeave"; data: {ieeeAddr: string}}
  | {type: "permitJoinChanged"; data: {permitted: boolean; time?: number}}
  | {type: "adapterDisconnected"; data: Record<string, never>}
  | {type: "message"; data: Events.MessagePayload};

export interface CoordinatorConnection {
  readonly connected: boolean;
  readonly startInfo: CoordinatorStartInfo | undefined;
  readonly adapterInfo: ProbeResult | undefined;
  connect(): Promise<CoordinatorStartInfo>;
  disconnect(): Promise<void>;
  subscribe(listener: (event: CoordinatorEvent) => void): () => void;
  permitJoin(seconds: number): Promise<void>;
  devices(predicate?: (device: Models.Device) => boolean): Models.Device[];
  devicesByType(type: "Coordinator" | "Router" | "EndDevice" | "Unknown" | "GreenPower"): Models.Device[];
}

export interface CoordinatorConnectionOptions {
  port: string;
  dataDirectory?: string;
  output?: (event: string, data: unknown) => void;
}

export class EmberCoordinatorConnection implements CoordinatorConnection {
  readonly #port: string;
  readonly #paths: RuntimePaths;
  readonly #output: (event: string, data: unknown) => void;
  readonly #listeners = new Set<(event: CoordinatorEvent) => void>();
  #controller?: Controller;
  #startInfo?: CoordinatorStartInfo;
  #adapterInfo?: ProbeResult;
  #connected = false;

  constructor(options: CoordinatorConnectionOptions) {
    this.#port = options.port;
    this.#paths = runtimePaths(options.dataDirectory);
    this.#output = options.output ?? (() => undefined);
  }

  get connected(): boolean {
    return this.#connected;
  }

  get startInfo(): CoordinatorStartInfo | undefined {
    return this.#startInfo;
  }

  get adapterInfo(): ProbeResult | undefined {
    return this.#adapterInfo;
  }

  async connect(): Promise<CoordinatorStartInfo> {
    if (this.#controller && this.#connected && this.#startInfo) return this.#startInfo;
    this.#output("adapter_probe_started", {port: this.#port});
    const probe = await probePort(this.#port);
    this.#adapterInfo = probe;
    if (!probe.supportedByHost) throw new Error(`EZSP protocol ${probe.protocolVersion} is not supported by this host library`);
    if (!probe.meetsRecommendedFirmware) throw new Error(`Coordinator firmware ${probe.firmware} is older than the required 7.4.4`);
    this.#output("adapter_found", probe);

    const {network, created} = await loadOrCreateNetwork(this.#paths);
    const controller = new Controller({
      network: {...network, networkKeyDistribute: false},
      serialPort: {path: this.#port, adapter: "ember", baudRate: 115200, rtscts: false},
      databasePath: this.#paths.database,
      databaseBackupPath: this.#paths.databaseBackup,
      backupPath: this.#paths.coordinatorBackup,
      adapter: {disableLED: false},
      acceptJoiningDeviceHandler: async () => true,
    });
    this.#wireController(controller);
    this.#output("coordinator_connecting", {port: this.#port});
    try {
      const result = await controller.start();
      const parameters = await controller.getNetworkParameters();
      this.#controller = controller;
      this.#connected = true;
      this.#startInfo = {result, createdNetworkConfig: created, firmware: probe.firmware, ...parameters};
      this.#output("coordinator_started", this.#startInfo);
      return this.#startInfo;
    } catch (error) {
      await controller.stop().catch(() => undefined);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const controller = this.#controller;
    this.#connected = false;
    if (!controller) return;
    await controller.stop().catch(() => undefined);
    this.#controller = undefined;
    this.#startInfo = undefined;
    this.#output("coordinator_stopped", {});
  }

  subscribe(listener: (event: CoordinatorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async permitJoin(seconds: number): Promise<void> {
    await this.#requiredController().permitJoin(seconds);
  }

  devices(predicate?: (device: Models.Device) => boolean): Models.Device[] {
    return [...this.#requiredController().getDevicesIterator(predicate)];
  }

  devicesByType(type: "Coordinator" | "Router" | "EndDevice" | "Unknown" | "GreenPower"): Models.Device[] {
    return this.#requiredController().getDevicesByType(type);
  }

  #requiredController(): Controller {
    if (!this.#controller || !this.#connected) throw new Error("Coordinator connection is not open");
    return this.#controller;
  }

  #emit(event: CoordinatorEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #wireController(controller: Controller): void {
    controller.on("deviceJoined", (data) => this.#emit({type: "deviceJoined", data}));
    controller.on("deviceInterview", (data) => this.#emit({type: "deviceInterview", data}));
    controller.on("deviceAnnounce", (data) => this.#emit({type: "deviceAnnounce", data}));
    controller.on("deviceNetworkAddressChanged", (data) => this.#emit({type: "deviceNetworkAddressChanged", data}));
    controller.on("deviceLeave", (data) => this.#emit({type: "deviceLeave", data}));
    controller.on("permitJoinChanged", (data) => this.#emit({type: "permitJoinChanged", data}));
    controller.on("adapterDisconnected", () => {
      if (this.#controller !== controller || !this.#connected) return;
      this.#connected = false;
      this.#startInfo = undefined;
      this.#emit({type: "adapterDisconnected", data: {}});
    });
    controller.on("message", (data) => this.#emit({type: "message", data}));
  }
}
