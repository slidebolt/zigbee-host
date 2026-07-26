import {runtimePaths} from "./config.js";
import {EmberCoordinatorConnection, type CoordinatorConnection} from "./coordinator-connection.js";
import type {CoordinatorStartInfo} from "./types.js";
import {ZigbeeService} from "./zigbee-service.js";
import {DeviceCommandEngine} from "./command-engine.js";

export interface ManagedZigbeeRuntime {
  readonly gateway: ZigbeeService;
  readonly connection: CoordinatorConnection;
  readonly commands: DeviceCommandEngine;
  start(): Promise<CoordinatorStartInfo>;
  stop(): Promise<void>;
}

export interface RuntimeManagerOptions {
  port: string;
  dataDirectory?: string;
  output?: (event: string, data: unknown) => void;
}

export class ZigbeeRuntimeManager implements ManagedZigbeeRuntime {
  readonly connection: CoordinatorConnection;
  readonly gateway: ZigbeeService;
  readonly commands: DeviceCommandEngine;
  #started = false;

  constructor(options: RuntimeManagerOptions) {
    const paths = runtimePaths(options.dataDirectory);
    this.connection = new EmberCoordinatorConnection(options);
    this.gateway = new ZigbeeService({connection: this.connection, stateFile: paths.state, output: options.output});
    this.commands = new DeviceCommandEngine({port: this.gateway, storeFile: paths.commands, output: options.output});
  }

  async start(): Promise<CoordinatorStartInfo> {
    const info = await this.connection.connect();
    try {
      await this.gateway.start();
      await this.commands.start();
      this.#started = true;
      return info;
    } catch (error) {
      await this.connection.disconnect().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.commands.stop().catch(() => undefined);
    if (this.#started) await this.gateway.stop().catch(() => undefined);
    this.#started = false;
    await this.connection.disconnect().catch(() => undefined);
  }
}
