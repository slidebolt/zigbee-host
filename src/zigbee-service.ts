import type {Events, Models} from "zigbee-herdsman";
import * as zhc from "zigbee-herdsman-converters";
import type {Definition, OnEvent, Tz} from "zigbee-herdsman-converters";
import type {CoordinatorConnection, CoordinatorEvent} from "./coordinator-connection.js";
import {flattenExposes} from "./device-utils.js";
import {StateStore, type DeviceState, type DeviceStateSnapshot} from "./state-store.js";
import type {
  DeviceInfo,
  ExposedProperty,
  ResolvedDevice,
  StateEvent,
  StateOrigin,
  SetResult,
  DeviceReachability,
} from "./types.js";

const ACCESS_SET = 0b010;
const ACCESS_GET = 0b100;

export interface ZigbeeServiceOptions {
  connection: CoordinatorConnection;
  stateFile: string;
  output?: (event: string, data: unknown) => void;
}

export class ZigbeeOperationError extends Error {
  constructor(readonly code: string, readonly phase: "send" | "read" | "observe", readonly retryable: boolean, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class ZigbeeService {
  readonly #connection: CoordinatorConnection;
  readonly #output: (event: string, data: unknown) => void;
  readonly #definitions = new Map<string, Definition>();
  readonly #state: StateStore;
  #started = false;
  #unsubscribe?: () => void;
  readonly #deviceWaiters = new Set<{
    predicate: (device: DeviceInfo) => boolean;
    resolve: (device: DeviceInfo) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  readonly #stateWaiters = new Set<{
    ieeeAddress: string;
    property: string;
    predicate: (value: unknown, event: StateEvent) => boolean;
    origins: Set<StateOrigin>;
    resolve: (event: StateEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  readonly #stateSubscribers = new Set<(event: StateEvent) => void>();
  readonly #reachability = new Map<string, DeviceReachability>();

  constructor(options: ZigbeeServiceOptions) {
    this.#connection = options.connection;
    this.#state = new StateStore(options.stateFile);
    this.#output = options.output ?? ((event, data) => console.log(JSON.stringify({event, data})));
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (!this.#connection.connected) throw new Error("Device runtime cannot start before the coordinator connection");
    await this.#state.load();
    this.#unsubscribe = this.#connection.subscribe((event) => this.#handleCoordinatorEvent(event));
    this.#started = true;
    for (const device of this.#connection.devices((candidate) => candidate.type !== "Coordinator")) {
      if (!this.#reachability.has(device.ieeeAddr)) this.#reachability.set(device.ieeeAddr, {status: "unknown"});
      const definition = await this.#resolveDefinition(device);
      await this.#callOnEvent(device, "start");
      if (definition?.configure && device.meta.configured !== definition.version) {
        await this.#configure(device).catch((error) => this.#eventError("configure", error));
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    if (this.#connection.connected) {
      for (const device of this.#connection.devices((candidate) => candidate.type !== "Coordinator")) {
        await this.#callOnEvent(device, "stop").catch(() => undefined);
      }
    }
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#started = false;
    this.#rejectWaiters(new Error("Coordinator stopped"));
  }

  async waitForDevice(predicate: (device: DeviceInfo) => boolean, timeoutMs: number): Promise<DeviceInfo> {
    const existing = (await this.listDevices()).find(predicate);
    if (existing) return existing;
    return await new Promise<DeviceInfo>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (device: DeviceInfo): void => {
          clearTimeout(waiter.timer);
          this.#deviceWaiters.delete(waiter);
          resolve(device);
        },
        reject: (error: Error): void => {
          clearTimeout(waiter.timer);
          this.#deviceWaiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => undefined, timeoutMs),
      };
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => waiter.reject(new Error(`Timed out after ${timeoutMs}ms waiting for device interview`)), timeoutMs);
      this.#deviceWaiters.add(waiter);
    });
  }

  async waitForState(
    ieeeAddress: string,
    property: string,
    predicate: (value: unknown, event: StateEvent) => boolean,
    timeoutMs: number,
    origins: StateOrigin[] = ["device", "read-response"],
  ): Promise<StateEvent> {
    return await new Promise<StateEvent>((resolve, reject) => {
      const waiter = {
        ieeeAddress: ieeeAddress.toLowerCase(),
        property,
        predicate,
        origins: new Set(origins),
        resolve: (event: StateEvent): void => {
          clearTimeout(waiter.timer);
          this.#stateWaiters.delete(waiter);
          resolve(event);
        },
        reject: (error: Error): void => {
          clearTimeout(waiter.timer);
          this.#stateWaiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => undefined, timeoutMs),
      };
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(
        () => waiter.reject(new Error(`Timed out after ${timeoutMs}ms waiting for device-reported '${property}'`)),
        timeoutMs,
      );
      this.#stateWaiters.add(waiter);
    });
  }

  subscribeState(subscriber: (event: StateEvent) => void): () => void {
    this.#stateSubscribers.add(subscriber);
    return () => this.#stateSubscribers.delete(subscriber);
  }

  async permitJoin(seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 254) {
      throw new Error("Join duration must be an integer from 1 through 254 seconds");
    }
    await this.#connection.permitJoin(seconds);
    this.#output("permit_join", {permitted: true, seconds});
  }

  async closeJoin(): Promise<void> {
    await this.#connection.permitJoin(0);
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const result: DeviceInfo[] = [];
    for (const device of this.#connection.devices((candidate) => candidate.type !== "Coordinator")) {
      const definition = await this.#resolveDefinition(device);
      result.push({
        ieeeAddress: device.ieeeAddr,
        networkAddress: device.networkAddress,
        type: device.type,
        interviewState: device.interviewState,
        manufacturerName: device.manufacturerName,
        modelID: device.modelID,
        definition: definition ? {
          vendor: definition.vendor,
          model: definition.model,
          description: definition.description,
          generated: definition.generated === true,
        } : undefined,
        exposes: definition ? flattenExposes(definition, device) : [],
        reachability: this.#reachability.get(device.ieeeAddr) ?? {status: "unknown"},
      });
    }
    return result;
  }

  async getDevice(selector: string): Promise<DeviceInfo> {
    const {device, definition} = await this.#findDevice(selector);
    return {
      ieeeAddress: device.ieeeAddr,
      networkAddress: device.networkAddress,
      type: device.type,
      interviewState: device.interviewState,
      manufacturerName: device.manufacturerName,
      modelID: device.modelID,
      definition: {
        vendor: definition.vendor,
        model: definition.model,
        description: definition.description,
        generated: definition.generated === true,
      },
      exposes: flattenExposes(definition, device),
      reachability: this.#reachability.get(device.ieeeAddr) ?? {status: "unknown"},
    };
  }

  async set(selector: string, property: string, value: unknown, endpointName?: string): Promise<SetResult> {
    const {device, definition} = await this.#findDevice(selector);
    const exposed = this.#findExpose(definition, device, property, ACCESS_SET, endpointName);
    const endpoint = this.#endpointFor(device, definition, exposed);
    const converter = definition.toZigbee.find((candidate) => (!candidate.key || candidate.key.includes(property)) && candidate.convertSet);
    if (!converter?.convertSet) throw new Error(`No set converter is available for '${property}'`);

    const meta = this.#toZigbeeMeta(device, definition, property, value, exposed.endpoint);
    let result;
    try {
      result = await converter.convertSet(endpoint, property, value, meta);
      this.#markReachable(device.ieeeAddr);
    } catch (error) {
      throw this.#operationError(device.ieeeAddr, "send", error);
    }
    const expected = result?.state ?? {[property]: value};
    if (result?.state) await this.#publishState(device, result.state, "optimistic");
    const state = this.#state.get(device.ieeeAddr);
    this.#output("command", {device: device.ieeeAddr, property, value, expected, state});
    return {state, expected};
  }

  async get(selector: string, property: string, endpointName?: string): Promise<DeviceState> {
    const {device, definition} = await this.#findDevice(selector);
    const exposed = this.#findExpose(definition, device, property, ACCESS_GET, endpointName);
    const endpoint = this.#endpointFor(device, definition, exposed);
    const converter = definition.toZigbee.find((candidate) => (!candidate.key || candidate.key.includes(property)) && candidate.convertGet);
    if (!converter?.convertGet) throw new Error(`No get converter is available for '${property}'`);
    try {
      await converter.convertGet(endpoint, property, this.#toZigbeeMeta(device, definition, property, undefined, exposed.endpoint));
    } catch (error) {
      throw this.#operationError(device.ieeeAddr, "read", error);
    }
    return this.#state.get(device.ieeeAddr);
  }

  async getCachedState(selector: string): Promise<DeviceState> {
    const {device} = await this.#findDevice(selector);
    return this.#state.get(device.ieeeAddr);
  }

  async getStateSnapshot(selector: string): Promise<DeviceStateSnapshot> {
    const {device} = await this.#findDevice(selector);
    return this.#state.snapshot(device.ieeeAddr);
  }

  getStateSnapshotById(ieeeAddress: string): DeviceStateSnapshot {
    return this.#state.snapshot(ieeeAddress);
  }

  async markPending(selector: string, commandId: string, values: DeviceState, requestedAt: string): Promise<void> {
    const {device} = await this.#findDevice(selector);
    await this.#state.markPending(device.ieeeAddr, commandId, values, requestedAt);
  }

  async clearPending(selector: string, commandId: string): Promise<void> {
    const {device} = await this.#findDevice(selector);
    await this.#state.clearPending(device.ieeeAddr, commandId);
  }

  async #findDevice(selector: string): Promise<ResolvedDevice> {
    const normalized = selector.toLowerCase();
    const matches: ResolvedDevice[] = [];
    for (const device of this.#connection.devices((candidate) => candidate.type !== "Coordinator")) {
      const definition = await this.#resolveDefinition(device);
      if (!definition) continue;
      if ([device.ieeeAddr, device.modelID, definition.model].some((value) => value?.toLowerCase() === normalized)) {
        matches.push({device, definition});
      }
    }
    if (matches.length === 0) throw new Error(`No paired device matches '${selector}'`);
    if (matches.length > 1) throw new Error(`'${selector}' matches multiple devices; use the IEEE address`);
    return matches[0]!;
  }

  #findExpose(definition: Definition, device: Models.Device, property: string, requiredAccess: number, endpointName?: string): ExposedProperty {
    const matches = flattenExposes(definition, device).filter((expose) => expose.property === property && (endpointName === undefined || expose.endpoint === endpointName) && (expose.access & requiredAccess) !== 0);
    if (matches.length === 0) {
      const operation = requiredAccess === ACCESS_SET ? "set" : "get";
      throw new Error(`Device '${definition.model}' does not expose '${property}' for ${operation}`);
    }
    return matches[0]!;
  }

  #endpointFor(device: Models.Device, definition: Definition, exposed: ExposedProperty): Models.Endpoint {
    const mapping = definition.endpoint?.(device);
    const id = exposed.endpoint ? mapping?.[exposed.endpoint] : mapping?.default;
    const endpoint = id === undefined ? device.endpoints[0] : device.getEndpoint(id);
    if (!endpoint) throw new Error(`No endpoint is available for '${exposed.property}'`);
    return endpoint;
  }

  #toZigbeeMeta(device: Models.Device, definition: Definition, property: string, value: unknown, endpointName?: string): Tz.Meta {
    return {
      endpoint_name: endpointName,
      options: {},
      message: {[property]: value},
      device,
      state: this.#state.get(device.ieeeAddr),
      mapped: definition,
      publish: (payload) => void this.#publishState(device, payload, "optimistic"),
    };
  }

  async #resolveDefinition(device: Models.Device, force = false): Promise<Definition | undefined> {
    if (force) this.#definitions.delete(device.ieeeAddr);
    const cached = this.#definitions.get(device.ieeeAddr);
    if (cached) return cached;
    const definition = await zhc.findByDevice(device, true);
    if (definition) {
      this.#output("definition_resolved", {
        ieeeAddress: device.ieeeAddr,
        zigbeeManufacturer: device.manufacturerName,
        zigbeeModel: device.modelID,
        vendor: definition.vendor,
        model: definition.model,
        description: definition.description,
        generated: definition.generated === true,
        capabilities: flattenExposes(definition, device).map((expose) => expose.property),
      });
    }
    // During deviceJoined the interview has not populated modelID/manufacturerName yet.
    // Do not retain the generated fallback or it will hide the real definition when
    // the interview completes a moment later.
    if (definition && !definition.generated) this.#definitions.set(device.ieeeAddr, definition);
    return definition;
  }

  async #configure(device: Models.Device): Promise<void> {
    const definition = await this.#resolveDefinition(device);
    if (!definition?.configure) return;
    const coordinator = this.#connection.devicesByType("Coordinator")[0];
    const endpoint = coordinator?.endpoints[0];
    if (!endpoint) throw new Error("Coordinator endpoint is unavailable");
    this.#output("device_configuration_started", {ieeeAddress: device.ieeeAddr, model: definition.model});
    try {
      await definition.configure(device, endpoint, definition);
      device.meta.configured = definition.version;
      device.save();
      this.#output("device_configured", {device: device.ieeeAddr, model: definition.model, definitionVersion: definition.version});
    } catch (error) {
      this.#output("device_configuration_failed", {device: device.ieeeAddr, model: definition.model, message: error instanceof Error ? error.message : String(error)});
      throw error;
    }
  }

  async #handleMessage(data: Events.MessagePayload): Promise<void> {
    const definition = await this.#resolveDefinition(data.device);
    if (!definition) return;
    const converters = definition.fromZigbee.filter((converter) => {
      const types = Array.isArray(converter.type) ? converter.type : [converter.type];
      return converter.cluster === data.cluster && types.includes(data.type as never);
    });
    if (converters.length === 0) return;

    const publish = (payload: DeviceState): void => {
      zhc.postProcessConvertedFromZigbeeMessage(definition, payload, {}, data.device);
      void this.#publishState(data.device, payload, data.type === "readResponse" ? "read-response" : "device");
    };
    let payload: DeviceState = {};
    for (const converter of converters) {
      const converted = await converter.convert(
        definition,
        data as never,
        publish,
        {},
        {device: data.device, state: this.#state.get(data.device.ieeeAddr), deviceExposesChanged: () => undefined},
      );
      if (converted) payload = {...payload, ...converted};
    }
    if (Object.keys(payload).length > 0) publish(payload);
  }

  async #publishState(device: Models.Device, payload: DeviceState, origin: StateOrigin): Promise<DeviceState> {
    const state = origin === "optimistic" ? this.#state.get(device.ieeeAddr) : await this.#state.merge(device.ieeeAddr, payload, origin);
    const event: StateEvent = {device: device.ieeeAddr, modelID: device.modelID, payload, state, origin};
    if (origin !== "optimistic") this.#markReachable(device.ieeeAddr);
    this.#output("state", event);
    for (const subscriber of this.#stateSubscribers) subscriber(event);
    for (const waiter of [...this.#stateWaiters]) {
      const value = payload[waiter.property];
      if (
        device.ieeeAddr.toLowerCase() === waiter.ieeeAddress &&
        Object.hasOwn(payload, waiter.property) &&
        waiter.origins.has(origin) &&
        waiter.predicate(value, event)
      ) {
        waiter.resolve(event);
      }
    }
    return state;
  }

  async #callOnEvent(device: Models.Device, type: OnEvent.Event["type"]): Promise<void> {
    const definition = await this.#resolveDefinition(device);
    const base = {
      device,
      state: this.#state.get(device.ieeeAddr),
      options: {},
      deviceExposesChanged: () => undefined,
    };
    if (type === "stop") {
      await definition?.onEvent?.({type, data: {ieeeAddr: device.ieeeAddr}});
      return;
    }
    if (type === "deviceInterview") return;
    const event = {type, data: base} as OnEvent.Event;
    await zhc.onEvent(event);
    await definition?.onEvent?.(event);
  }

  #handleCoordinatorEvent(event: CoordinatorEvent): void {
    if (event.type === "deviceJoined") {
      const {device} = event.data;
      this.#output("device_joined", {ieeeAddress: device.ieeeAddr, networkAddress: device.networkAddress});
      void this.#callOnEvent(device, "deviceJoined").catch((error) => this.#eventError("deviceJoined", error));
    } else if (event.type === "deviceInterview") {
      const {device, status} = event.data;
      this.#output("device_interview", {ieeeAddress: device.ieeeAddr, status, modelID: device.modelID});
      if (status === "successful") {
        void this.#resolveDefinition(device, true)
          .then(() => this.#configure(device))
          .then(() => this.listDevices())
          .then((devices) => {
            this.#output("devices", devices);
            const ready = devices.find((candidate) => candidate.ieeeAddress === device.ieeeAddr);
            if (ready) this.#notifyDevice(ready);
          })
          .catch((error) => this.#eventError("configure", error));
      }
    } else if (event.type === "deviceAnnounce") {
      const {device} = event.data;
      this.#markReachable(device.ieeeAddr);
      void this.#callOnEvent(device, "deviceAnnounce").catch((error) => this.#eventError("deviceAnnounce", error));
    } else if (event.type === "deviceNetworkAddressChanged") {
      const {device} = event.data;
      void this.#callOnEvent(device, "deviceNetworkAddressChanged").catch((error) => this.#eventError("deviceNetworkAddressChanged", error));
    } else if (event.type === "deviceLeave") {
      const {ieeeAddr} = event.data;
      this.#definitions.delete(ieeeAddr);
      this.#output("device_left", {ieeeAddress: ieeeAddr});
    } else if (event.type === "permitJoinChanged") {
      this.#output("permit_join", event.data);
    } else if (event.type === "adapterDisconnected") {
      for (const [ieeeAddress, current] of this.#reachability) {
        this.#reachability.set(ieeeAddress, {...current, status: "unknown", reason: "coordinator_disconnected"});
      }
      this.#output("adapter_disconnected", {});
    } else if (event.type === "message") {
      void this.#handleMessage(event.data).catch((error) => this.#eventError("message", error));
    }
  }

  #eventError(context: string, error: unknown): void {
    this.#output("error", {context, message: error instanceof Error ? error.message : String(error)});
  }

  #markReachable(ieeeAddress: string): void {
    const now = new Date().toISOString();
    const next: DeviceReachability = {status: "reachable", lastSeen: now, lastSuccess: now};
    this.#reachability.set(ieeeAddress, next);
    this.#output("device_reachability", {deviceId: ieeeAddress, reachability: next});
  }

  #operationError(ieeeAddress: string, phase: "send" | "read", error: unknown): ZigbeeOperationError {
    const detail = error instanceof Error ? error.message : String(error);
    const code = detail.includes("Delivery failed") ? "device_unreachable" : detail.includes("Coordinator connection is not open") ? "coordinator_disconnected" : /timed? out|timeout/i.test(detail) ? "transport_timeout" : "zigbee_operation_failed";
    if (code === "device_unreachable" || code === "transport_timeout") {
      const at = new Date().toISOString();
      const reachability: DeviceReachability = {status: "unreachable", reason: code, lastFailure: {at, code, phase, detail}};
      this.#reachability.set(ieeeAddress, reachability);
      this.#output("device_reachability", {deviceId: ieeeAddress, reachability});
    }
    return new ZigbeeOperationError(code, phase, code !== "zigbee_operation_failed", detail, {cause: error});
  }

  #notifyDevice(device: DeviceInfo): void {
    for (const waiter of [...this.#deviceWaiters]) {
      if (waiter.predicate(device)) waiter.resolve(device);
    }
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of [...this.#deviceWaiters]) waiter.reject(error);
    for (const waiter of [...this.#stateWaiters]) waiter.reject(error);
  }
}
