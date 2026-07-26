import {randomUUID} from "node:crypto";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {Socket} from "node:net";
import {mkdir, readFile, unlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {runCommission} from "./commission.js";
import {HOST_ADDRESS, HOST_PORT, type HostPaths} from "./host-config.js";
import {HostEventHub} from "./observability.js";
import {OPENAPI_DOCUMENT} from "./openapi.js";
import {CommandStore} from "./command-store.js";
import {StateStore} from "./state-store.js";
import {DeviceCatalog} from "./device-catalog.js";
import type {LocatedAdapter} from "./adapter-locator.js";
import {ZigbeeOperationError} from "./zigbee-service.js";
import type {ManagedZigbeeRuntime} from "./runtime-manager.js";
import type {ApiDevice, ApiDeviceSummary, DeviceCapability, DeviceInfo, ProbeResult} from "./types.js";
import {canonicalProperty, commandValues, normalizeDevice} from "./component-model.js";

interface Operation {
  id: string;
  type: "commission";
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  response.end(`${JSON.stringify(value)}\n`);
}

export function isAuthorized(authorization: string | undefined, token: string): boolean {
  return authorization === `Bearer ${token}`;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > 1_048_576) throw new Error("Request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
  return parsed as Record<string, unknown>;
}

const ACCESS_STATE = 0b001;
const ACCESS_SET = 0b010;
const ACCESS_GET = 0b100;

export function toApiCapability(expose: DeviceInfo["exposes"][number]): DeviceCapability {
  return {
    name: expose.property,
    type: expose.type,
    access: {
      read: (expose.access & ACCESS_GET) !== 0,
      write: (expose.access & ACCESS_SET) !== 0,
      reports: (expose.access & ACCESS_STATE) !== 0,
    },
    ...(expose.endpoint === undefined ? {} : {endpoint: expose.endpoint}),
    ...(expose.unit === undefined ? {} : {unit: expose.unit}),
    ...(expose.values === undefined ? {} : {values: expose.values}),
    ...(expose.valueMin === undefined ? {} : {minimum: expose.valueMin}),
    ...(expose.valueMax === undefined ? {} : {maximum: expose.valueMax}),
    ...(expose.valueStep === undefined ? {} : {step: expose.valueStep}),
  };
}

function kind(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

export function toApiDeviceSummary(device: DeviceInfo): ApiDeviceSummary {
  return {
    id: device.ieeeAddress,
    ...(device.definition?.vendor || device.manufacturerName ? {manufacturer: device.definition?.vendor || device.manufacturerName} : {}),
    ...(device.definition?.model || device.modelID ? {model: device.definition?.model || device.modelID} : {}),
    kind: kind(device.type),
    interview: device.interviewState.toLowerCase(),
    reachability: device.reachability ?? {status: "unknown"},
  };
}

export function toApiDevice(device: DeviceInfo): ApiDevice {
  return {
    ...toApiDeviceSummary(device),
    ...(device.definition?.description ? {description: device.definition.description} : {}),
    network: {address: device.networkAddress, kind: kind(device.type)},
    ...(device.definition ? {definition: {
      vendor: device.definition.vendor,
      model: device.definition.model,
      generated: device.definition.generated,
    }} : {}),
    capabilities: device.exposes.map(toApiCapability),
  };
}

export interface ZigbeeHostOptions {
  token: string;
  paths: HostPaths;
  port?: number;
  address?: string;
  runtimeFactory: (output: (event: string, data: unknown) => void, port: string) => ManagedZigbeeRuntime;
  probeAdapter: (port: string) => Promise<ProbeResult>;
  locateAdapter: () => Promise<LocatedAdapter>;
}

export class ZigbeeHost {
  readonly #token: string;
  readonly #paths: HostPaths;
  readonly #port: number;
  readonly #address: string;
  readonly #operations = new Map<string, Operation>();
  readonly #operationAborts = new Map<string, AbortController>();
  readonly #commandRequestIds = new Map<string, string>();
  readonly #sockets = new Set<Socket>();
  #hub?: HostEventHub;
  readonly #runtimeFactory: ZigbeeHostOptions["runtimeFactory"];
  readonly #probeAdapter: ZigbeeHostOptions["probeAdapter"];
  readonly #locateAdapter: ZigbeeHostOptions["locateAdapter"];
  #manager?: ManagedZigbeeRuntime;
  #server?: Server;
  #heartbeat?: NodeJS.Timeout;
  #joinEnd = 0;
  #joinPhase = "waiting";
  #joinDuration = 60;
  #maintenance = false;
  #stopping = false;
  #connectionState: "starting" | "connected" | "reconnecting" | "disconnected" | "stopping" = "starting";
  #reconnectAttempt = 0;
  #nextAttemptAt?: string;
  #lastConnectionError?: string;
  #activePort?: string;
  #adapterEui64?: string;
  #reconnectAbort = new AbortController();
  #reconnectTask?: Promise<void>;
  #offlineCommands?: CommandStore;
  #offlineState?: StateStore;
  #catalog?: DeviceCatalog;

  constructor(options: ZigbeeHostOptions) {
    this.#token = options.token;
    this.#paths = options.paths;
    this.#port = options.port ?? HOST_PORT;
    this.#address = options.address ?? HOST_ADDRESS;
    this.#runtimeFactory = options.runtimeFactory;
    this.#probeAdapter = options.probeAdapter;
    this.#locateAdapter = options.locateAdapter;
  }

  get listeningPort(): number | undefined {
    const address = this.#server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  async start(): Promise<void> {
    this.#hub = await HostEventHub.create(this.#paths.logs);
    this.#offlineCommands = new CommandStore(path.join(this.#paths.data, "commands.json"));
    await this.#offlineCommands.load();
    this.#offlineState = new StateStore(path.join(this.#paths.data, "state.json"));
    await this.#offlineState.load();
    this.#catalog = new DeviceCatalog(path.join(this.#paths.data, "device-catalog.json"));
    await this.#catalog.load();
    try {
      const pairing = JSON.parse(await readFile(path.join(this.#paths.data, "pairing.json"), "utf8")) as {durationSeconds?: number};
      if (Number.isInteger(pairing.durationSeconds) && pairing.durationSeconds! >= 10 && pairing.durationSeconds! <= 254) this.#joinDuration = pairing.durationSeconds!;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#server = createServer((request, response) => void this.#handle(request, response));
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#port, this.#address, resolve);
    });
    await mkdir(this.#paths.runtime, {recursive: true});
    await writeFile(this.#paths.status, `${JSON.stringify({pid: process.pid, address: this.#address, port: this.#port, startedAt: new Date().toISOString()})}\n`, "utf8");
    this.#hub.emit("host_started", {pid: process.pid, address: this.#address, port: this.#port}, undefined, "host");
    this.#scheduleReconnect("host_start");
    this.#heartbeat = setInterval(() => {
      if (this.#joinEnd > 0 && this.#joinEnd <= Date.now()) {
        this.#joinEnd = 0;
        this.#hub?.emit("pairing.changed", this.#pairingStatus(), undefined, "device");
      }
      if (this.#joinEnd > Date.now()) {
        this.#hub?.emit("join_wait_progress", {remainingSeconds: Math.ceil((this.#joinEnd - Date.now()) / 1000), phase: this.#joinPhase}, undefined, "progress");
      } else {
        this.#hub?.emit("host_heartbeat", {connected: this.#connectionState === "connected", coordinatorState: this.#connectionState, reconnectAttempt: this.#reconnectAttempt, nextAttemptAt: this.#nextAttemptAt}, undefined, "progress");
      }
    }, 5000);
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#connectionState = "stopping";
    this.#reconnectAbort.abort();
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    const closed = new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
    for (const socket of this.#sockets) socket.destroy();
    await closed;
    await this.#reconnectTask?.catch(() => undefined);
    await this.#manager?.stop().catch(() => undefined);
    this.#hub?.emit("host_stopped", {pid: process.pid}, undefined, "host");
    await this.#hub?.close();
    await unlink(this.#paths.status).catch(() => undefined);
  }

  #makeManager(port: string, requestId?: string): ManagedZigbeeRuntime {
    let manager: ManagedZigbeeRuntime;
    manager = this.#runtimeFactory((type, data) => {
        if (type === "device_joined") this.#joinPhase = "device discovered";
        if (type === "device_interview") this.#joinPhase = String((data as Record<string, unknown>).status ?? "interviewing");
        if (type === "permit_join" && !(data as Record<string, unknown>).permitted) this.#joinEnd = 0;
        this.#hub?.emit(type, data, requestId);
        void this.#publishIntegrationEvent(type, data, requestId, manager);
        if (type === "devices" && Array.isArray(data)) void this.#catalog?.replace(data as DeviceInfo[]).catch(() => undefined);
        if (type === "device_reachability") void manager.gateway.listDevices().then((devices) => this.#catalog?.replace(devices)).catch(() => undefined);
        if (type === "adapter_disconnected") this.#handleAdapterDisconnected(manager);
    }, port);
    return manager;
  }

  async #publishIntegrationEvent(type: string, data: unknown, requestId: string | undefined, manager: ManagedZigbeeRuntime): Promise<void> {
    const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
    if (type === "state") {
      const deviceId = String(record.device ?? "").toLowerCase();
      const device = this.#catalog?.get(deviceId);
      if (!device) return;
      const payload = record.payload && typeof record.payload === "object" ? record.payload as Record<string, unknown> : {};
      const state = record.state && typeof record.state === "object" ? record.state as Record<string, unknown> : {};
      const normalized = normalizeDevice(device, state);
      for (const component of normalized.components) {
        const patch: Record<string, unknown> = {};
        for (const [property, value] of Object.entries(payload)) {
          const endpointSuffix = component.endpoint ? `_${component.endpoint}` : "";
          const sourceProperty = endpointSuffix && property.endsWith(endpointSuffix) ? property.slice(0, -endpointSuffix.length) : property;
          const canonical = canonicalProperty(sourceProperty, component.kind);
          if (component.features[canonical]) patch[canonical] = value;
        }
        if (Object.keys(patch).length > 0) this.#hub?.emit("component.state_changed", {deviceId, componentId: component.id, revision: Date.now(), patch, origin: record.origin}, requestId, "device");
      }
      return;
    }
    if (type.startsWith("command.")) {
      const commandID = String(record.id ?? "");
      const correlation = this.#commandRequestIds.get(commandID) ?? requestId;
      this.#hub?.emit("command.changed", data, correlation, "command");
      if (["confirmed", "unverifiable", "inconclusive", "failed", "interrupted"].includes(String(record.status ?? type.slice("command.".length)))) this.#commandRequestIds.delete(commandID);
      return;
    }
    if (type === "devices" && Array.isArray(data)) {
      for (const device of data as DeviceInfo[]) {
        const state = manager.gateway.getStateSnapshotById(device.ieeeAddress).reported;
        this.#hub?.emit("device.upserted", normalizeDevice(device, state), requestId, "device");
      }
      return;
    }
    if (type === "device_reachability") {
      this.#hub?.emit("device.availability_changed", {deviceId: record.deviceId, reachability: record.reachability}, requestId, "device");
      return;
    }
    if (type === "device_left") {
      this.#hub?.emit("device.removed", {deviceId: record.ieeeAddress}, requestId, "device");
      return;
    }
    if (type === "permit_join") {
      this.#hub?.emit("pairing.changed", this.#pairingStatus(), requestId, "device");
      return;
    }
    if (["coordinator.connected", "coordinator.reconnected", "coordinator.disconnected"].includes(type)) {
      this.#hub?.emit("coordinator.changed", this.#coordinatorStatus(), requestId, "connection");
    }
  }

  #handleAdapterDisconnected(manager: ManagedZigbeeRuntime): void {
    if (this.#stopping || this.#maintenance || manager !== this.#manager || this.#connectionState !== "connected") return;
    this.#connectionState = "reconnecting";
    this.#lastConnectionError = "The coordinator was disconnected from the host";
    this.#hub?.emit("coordinator.disconnected", {port: this.#activePort, eui64: this.#adapterEui64}, undefined, "connection");
    this.#hub?.emit("coordinator.changed", this.#coordinatorStatus(), undefined, "connection");
    void this.#catalog?.markAllUnknown("coordinator_disconnected").catch(() => undefined);
    const connecting = this.#reconnectTask;
    if (connecting) void connecting.finally(() => this.#scheduleReconnect("adapter_disconnected", manager));
    else this.#scheduleReconnect("adapter_disconnected", manager);
  }

  #scheduleReconnect(reason: string, staleManager?: ManagedZigbeeRuntime): void {
    if (this.#stopping || this.#reconnectTask) return;
    if (this.#reconnectAbort.signal.aborted) this.#reconnectAbort = new AbortController();
    this.#connectionState = reason === "host_start" ? "starting" : "reconnecting";
    const signal = this.#reconnectAbort.signal;
    this.#reconnectTask = (async () => {
      if (staleManager) await withTimeout(staleManager.stop(), 5_000).catch((error) => this.#hub?.emit("reconnect.cleanup_failed", {message: String(error)}, undefined, "connection"));
      let delayMs = 0;
      while (!signal.aborted && !this.#stopping) {
        if (delayMs > 0) {
          this.#nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
          this.#hub?.emit("reconnect.scheduled", {reason, attempt: this.#reconnectAttempt + 1, delayMs, nextAttemptAt: this.#nextAttemptAt}, undefined, "connection");
          await abortableDelay(delayMs, signal);
        }
        if (signal.aborted) break;
        this.#reconnectAttempt++;
        this.#nextAttemptAt = undefined;
        this.#hub?.emit("reconnect.attempt", {reason, attempt: this.#reconnectAttempt}, undefined, "connection");
        let candidate: ManagedZigbeeRuntime | undefined;
        try {
          const located = await this.#locateAdapter();
          candidate = this.#makeManager(located.port);
          await candidate.start();
          if (signal.aborted) { await candidate.stop(); break; }
          this.#manager = candidate;
          this.#activePort = located.port;
          this.#adapterEui64 = located.identity.eui64;
          this.#connectionState = "connected";
          this.#lastConnectionError = undefined;
          this.#nextAttemptAt = undefined;
          const devices = await candidate.gateway.listDevices();
          await this.#catalog?.replace(devices);
          for (const device of devices) {
            this.#hub?.emit("device.upserted", normalizeDevice(device, candidate.gateway.getStateSnapshotById(device.ieeeAddress).reported), undefined, "device");
          }
          this.#hub?.emit(reason === "host_start" ? "coordinator.connected" : "coordinator.reconnected", {port: located.port, eui64: located.identity.eui64, attempt: this.#reconnectAttempt}, undefined, "connection");
          this.#hub?.emit("coordinator.changed", this.#coordinatorStatus(), undefined, "connection");
          this.#reconnectAttempt = 0;
          return;
        } catch (error) {
          await candidate?.stop().catch(() => undefined);
          this.#connectionState = "reconnecting";
          this.#lastConnectionError = error instanceof Error ? error.message : String(error);
          this.#hub?.emit("reconnect.failed", {attempt: this.#reconnectAttempt, message: this.#lastConnectionError}, undefined, "connection");
          this.#hub?.emit("coordinator.changed", this.#coordinatorStatus(), undefined, "connection");
          const backoff = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
          const baseDelay = backoff[Math.min(this.#reconnectAttempt - 1, backoff.length - 1)]!;
          delayMs = baseDelay + Math.floor(Math.random() * baseDelay * 0.2);
        }
      }
    })().finally(() => { this.#reconnectTask = undefined; });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID().slice(0, 8);
    response.setHeader("x-request-id", requestId);
    try {
      if (!isAuthorized(request.headers.authorization, this.#token)) {
        json(response, 401, {type: "unauthorized", title: "Authentication required", status: 401, detail: "A valid bearer token is required", requestId});
        return;
      }
      const url = new URL(request.url ?? "/", `http://${this.#address}:${this.#port}`);
      const method = request.method ?? "GET";
      this.#hub?.emit("http_request", {method, path: url.pathname}, requestId, "command");

      if (method === "GET" && url.pathname === "/v1/health") {
        json(response, 200, {version: 1, status: this.#maintenance ? "maintenance" : this.#connectionState === "connected" ? "ready" : "degraded", pid: process.pid, coordinator: this.#coordinatorStatus(), requestId});
      } else if (method === "GET" && url.pathname === "/v1/snapshot") {
        json(response, 200, await this.#snapshot());
      } else if (method === "GET" && url.pathname === "/v1/openapi.json") {
        json(response, 200, OPENAPI_DOCUMENT);
      } else if (method === "GET" && url.pathname === "/v1/adapter") {
        json(response, 200, {...this.#coordinatorStatus(), ...this.#manager?.connection.adapterInfo, ...this.#manager?.connection.startInfo, requestId});
      } else if (method === "GET" && url.pathname === "/v1/devices") {
        const devices = this.#connectionState === "connected" ? await this.#manager!.gateway.listDevices() : this.#catalog?.list() ?? [];
        if (this.#connectionState === "connected") await this.#catalog?.replace(devices);
        const items = devices.map((device) => normalizeDevice(device, this.#manager?.gateway.getStateSnapshotById(device.ieeeAddress).reported ?? this.#offlineState!.snapshot(device.ieeeAddress).reported));
        json(response, 200, {items, count: items.length});
      } else if (method === "GET" && url.pathname === "/v1/commands") {
        const requestedDeviceId = url.searchParams.get("deviceId");
        const deviceId = requestedDeviceId === null ? undefined : this.#deviceId(requestedDeviceId);
        const status = url.searchParams.get("status") ?? undefined;
        if (status && !["queued", "sending", "observing", "confirmed", "unverifiable", "inconclusive", "failed", "interrupted"].includes(status)) {
          throw new HttpError(400, "invalid_command_status", "status is not a valid command lifecycle state");
        }
        const limit = Number(url.searchParams.get("limit") ?? 100);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "invalid_limit", "limit must be an integer from 1 through 500");
        const items = (this.#manager?.commands ?? this.#offlineCommands!).list({deviceId, status, limit});
        json(response, 200, {items, count: items.length});
      } else if (method === "GET" && url.pathname.startsWith("/v1/commands/")) {
        const command = (this.#manager?.commands ?? this.#offlineCommands!).get(url.pathname.slice("/v1/commands/".length));
        if (!command) throw new HttpError(404, "command_not_found", "command not found");
        json(response, 200, {command});
      } else if (method === "GET" && url.pathname === "/v1/events") {
        const streamId = url.searchParams.get("streamId") ?? undefined;
        const headerCursor = request.headers["last-event-id"];
        const after = Number(url.searchParams.get("after") ?? (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor) ?? 0);
        if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "invalid_event_cursor", "after must be a non-negative integer");
        if (streamId && streamId !== this.#hub!.streamId) throw new HttpError(409, "event_cursor_expired", "event stream instance changed; fetch a new snapshot");
        const replay = this.#hub!.replay(after);
        if (!replay) throw new HttpError(409, "event_cursor_expired", "event cursor is no longer retained; fetch a new snapshot");
        this.#openEvents(response, replay);
      } else if (method === "GET" && url.pathname === "/v1/pairing") {
        json(response, 200, this.#pairingStatus());
      } else if (method === "PATCH" && url.pathname === "/v1/pairing/config") {
        const payload = await body(request);
        const duration = Number(payload.durationSeconds);
        if (!Number.isInteger(duration) || duration < 10 || duration > 254) throw new HttpError(400, "invalid_pairing_duration", "durationSeconds must be an integer from 10 through 254");
        this.#joinDuration = duration;
        await mkdir(this.#paths.data, {recursive: true});
        await writeFile(path.join(this.#paths.data, "pairing.json"), `${JSON.stringify({durationSeconds: duration}, null, 2)}\n`, "utf8");
        this.#hub?.emit("pairing.changed", this.#pairingStatus(), requestId, "device");
        json(response, 200, this.#pairingStatus());
      } else if (method === "POST" && url.pathname === "/v1/pairing/start") {
        this.#requireAvailable();
        await this.#manager!.gateway.permitJoin(this.#joinDuration);
        this.#joinEnd = Date.now() + this.#joinDuration * 1000;
        this.#joinPhase = "waiting";
        this.#hub?.emit("pairing.changed", this.#pairingStatus(), requestId, "device");
        json(response, 202, this.#pairingStatus());
      } else if (method === "POST" && url.pathname === "/v1/pairing/stop") {
        this.#requireAvailable();
        await this.#manager!.gateway.closeJoin();
        this.#joinEnd = 0;
        this.#hub?.emit("pairing.changed", this.#pairingStatus(), requestId, "device");
        json(response, 202, this.#pairingStatus());
      } else if (method === "POST" && url.pathname === "/v1/commission") {
        this.#requireAvailable();
        const payload = await body(request);
        if (payload.fresh !== true) throw new HttpError(400, "invalid_request", "fresh must be true");
        const operation = this.#startCommission(Number(payload.seconds ?? 180));
        json(response, 202, {operation, requestId});
      } else if (method === "GET" && url.pathname.startsWith("/v1/operations/")) {
        const operation = this.#operations.get(url.pathname.slice("/v1/operations/".length));
        if (!operation) throw new HttpError(404, "operation_not_found", "operation not found");
        json(response, 200, {operation, requestId});
      } else if (method === "DELETE" && url.pathname.startsWith("/v1/operations/")) {
        const id = url.pathname.slice("/v1/operations/".length);
        const operation = this.#operations.get(id);
        if (!operation) throw new HttpError(404, "operation_not_found", "operation not found");
        if (operation.status !== "running") throw new HttpError(409, "operation_not_running", "operation is not running");
        this.#operationAborts.get(id)?.abort();
        json(response, 202, {canceling: true, operationId: id, requestId});
      } else if (method === "POST" && url.pathname === "/v1/host/stop") {
        json(response, 202, {stopping: true, requestId});
        setTimeout(() => void this.stop().then(() => process.exit(0)), 20);
      } else {
        const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
        const componentCommandMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/components\/([^/]+)\/commands$/);
        if (method === "POST" && componentCommandMatch) {
          this.#requireAvailable();
          const deviceId = this.#deviceId(componentCommandMatch[1]!);
          const componentId = decodeURIComponent(componentCommandMatch[2]!);
          const payload = await body(request);
          if (typeof payload.action !== "string" || !payload.action) throw new HttpError(400, "invalid_request", "action is required");
          const parameters = payload.parameters && typeof payload.parameters === "object" && !Array.isArray(payload.parameters) ? payload.parameters as Record<string, unknown> : {};
          const device = await this.#manager!.gateway.getDevice(deviceId);
          const state = this.#manager!.gateway.getStateSnapshotById(deviceId).reported;
          const component = normalizeDevice(device, state).components.find((candidate) => candidate.id === componentId);
          if (!component) throw new HttpError(404, "component_not_found", "component not found");
          const values = commandValues(component, payload.action, parameters);
          const timeout = payload.observationTimeoutMs === undefined ? 30_000 : Number(payload.observationTimeoutMs);
          if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) throw new HttpError(400, "invalid_observation_timeout", "observationTimeoutMs must be an integer from 1000 through 300000");
          const componentEndpoint = component.endpoint;
          const endpoints = componentEndpoint ? Object.fromEntries(Object.keys(values).map((property) => [property, componentEndpoint])) : undefined;
          const command = await this.#manager!.commands.submit(deviceId, values, timeout, endpoints);
          const correlation = typeof payload.requestId === "string" && payload.requestId ? payload.requestId : requestId;
          this.#commandRequestIds.set(command.id, correlation);
          response.setHeader("location", `/v1/commands/${command.id}`);
          json(response, 202, {command});
        } else if (method === "GET" && deviceMatch) {
          const deviceId = this.#deviceId(deviceMatch[1]!);
          const device = this.#connectionState === "connected" ? await this.#manager!.gateway.getDevice(deviceId) : this.#catalog?.get(deviceId);
          if (!device) throw new HttpError(404, "device_not_found", "device not found in the cached catalog");
          const state = this.#manager?.gateway.getStateSnapshotById(deviceId).reported ?? this.#offlineState!.snapshot(deviceId).reported;
          json(response, 200, normalizeDevice(device, state));
        } else {
          throw new HttpError(404, "route_not_found", "not found");
        }
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status
        : error instanceof ZigbeeOperationError && ["device_unreachable", "coordinator_disconnected", "transport_timeout"].includes(error.code) ? 503
        : error instanceof SyntaxError || error instanceof URIError ? 400
        : error instanceof Error && error.message.startsWith("No paired device matches") ? 404
        : error instanceof Error && (error.message.includes("does not expose") || error.message.includes("converter is available")) ? 422
        : 500;
      const message = error instanceof Error ? error.message : String(error);
      this.#hub?.emit("error", {context: "http", message}, requestId, "command");
      if (!response.headersSent) json(response, status, {
        type: error instanceof HttpError ? error.code : error instanceof ZigbeeOperationError ? error.code : status === 404 ? "device_not_found" : status === 422 ? "unsupported_property" : status === 400 ? "invalid_request" : "internal_error",
        title: status === 404 ? "Device not found" : status === 422 ? "Unsupported device property" : status === 400 ? "Invalid request" : status === 504 ? "Device confirmation timed out" : "Request failed",
        status,
        detail: message,
        requestId,
        ...(error instanceof ZigbeeOperationError ? {phase: error.phase, retryable: error.retryable} : {}),
      });
      else response.end();
    }
  }

  async #snapshot(): Promise<Record<string, unknown>> {
    const sequence = this.#hub!.sequence;
    const devices = this.#connectionState === "connected" ? await this.#manager!.gateway.listDevices() : this.#catalog?.list() ?? [];
    if (this.#connectionState === "connected") await this.#catalog?.replace(devices);
    const normalized = devices.map((device) => {
      const state = this.#manager?.gateway.getStateSnapshotById(device.ieeeAddress).reported ?? this.#offlineState!.snapshot(device.ieeeAddress).reported;
      return normalizeDevice(device, state);
    });
    return {
      apiVersion: 1,
      streamId: this.#hub!.streamId,
      sequence,
      coordinator: {...this.#coordinatorStatus(), id: this.#adapterEui64 ?? "coordinator", pairedDevices: normalized.length},
      pairing: this.#pairingStatus(),
      devices: normalized,
    };
  }

  #pairingStatus(): Record<string, unknown> {
    const active = this.#joinEnd > Date.now();
    return {
      active,
      durationSeconds: this.#joinDuration,
      remainingSeconds: active ? Math.max(0, Math.ceil((this.#joinEnd - Date.now()) / 1000)) : 0,
      ...(active ? {endsAt: new Date(this.#joinEnd).toISOString(), phase: this.#joinPhase} : {}),
    };
  }

  #deviceId(encoded: string): string {
    const value = decodeURIComponent(encoded).toLowerCase();
    if (!/^0x[0-9a-f]{16}$/.test(value)) throw new HttpError(400, "invalid_device_id", "deviceId must be a 16-byte IEEE address such as 0x00124b0000000001");
    return value;
  }

  #openEvents(response: ServerResponse, replay: ReturnType<HostEventHub["replay"]>): void {
    response.writeHead(200, {"content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive"});
    response.write(`: connected stream=${this.#hub!.streamId}\n\n`);
    const write = (event: NonNullable<typeof replay>[number]): void => {
      if (!isIntegrationEvent(event.type)) return;
      response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({...event, streamId: this.#hub!.streamId})}\n\n`);
    };
    for (const event of replay ?? []) write(event);
    const unsubscribe = this.#hub!.subscribe((event) => {
      write(event);
    });
    response.once("close", unsubscribe);
  }

  #startCommission(seconds: number): Operation {
    if ([...this.#operations.values()].some((operation) => operation.status === "running")) throw new HttpError(409, "operation_conflict", "another operation is already running");
    const operation: Operation = {id: randomUUID(), type: "commission", status: "running", startedAt: new Date().toISOString()};
    const abort = new AbortController();
    this.#operations.set(operation.id, operation);
    this.#operationAborts.set(operation.id, abort);
    this.#maintenance = true;
    void (async () => {
      const port = this.#activePort!;
      try {
        await this.#manager!.stop();
        const result = await runCommission({
          dataDirectory: this.#paths.data,
          seconds,
          output: (type, data) => this.#hub?.emit(type, data, operation.id),
          signal: abort.signal,
          probeAdapter: () => this.#probeAdapter(port),
          createRuntime: () => this.#makeManager(port, operation.id),
        });
        operation.status = "passed";
        operation.result = {reportPath: result.reportPath};
      } catch (error) {
        operation.status = "failed";
        operation.error = error instanceof Error ? error.message : String(error);
      } finally {
        operation.finishedAt = new Date().toISOString();
        this.#operationAborts.delete(operation.id);
        this.#maintenance = false;
        this.#connectionState = "reconnecting";
        this.#scheduleReconnect("commission_finished");
        this.#hub?.emit("operation_finished", operation, operation.id, "command");
      }
    })();
    return operation;
  }

  #requireAvailable(): void {
    if (this.#maintenance) throw new HttpError(409, "host_in_maintenance", "host is in commissioning maintenance mode");
    if (this.#connectionState !== "connected" || !this.#manager?.connection.connected) throw new HttpError(503, "coordinator_reconnecting", `coordinator is ${this.#connectionState}`);
  }

  #coordinatorStatus(): Record<string, unknown> {
    const start = this.#manager?.connection.startInfo;
    return {
      state: this.#connectionState,
      connected: this.#connectionState === "connected",
      ...(this.#activePort ? {port: this.#activePort} : {}),
      ...(this.#adapterEui64 ? {eui64: this.#adapterEui64} : {}),
      attempt: this.#reconnectAttempt,
      ...(start ? {channel: start.channel, panID: start.panID, extendedPanID: start.extendedPanID, firmware: start.firmware} : {}),
      ...(this.#nextAttemptAt ? {nextAttemptAt: this.#nextAttemptAt} : {}),
      ...(this.#lastConnectionError ? {lastError: this.#lastConnectionError} : {}),
    };
  }
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

function isIntegrationEvent(type: string): boolean {
  return type === "coordinator.changed" || type === "pairing.changed" || type === "device.upserted" || type === "device.removed" || type === "device.availability_changed" || type === "component.upserted" || type === "component.removed" || type === "component.state_changed" || type === "command.changed";
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, {once: true});
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`Cleanup exceeded ${milliseconds}ms`)), milliseconds); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
