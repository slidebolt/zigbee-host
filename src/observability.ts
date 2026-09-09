import {createWriteStream, type WriteStream} from "node:fs";
import {mkdir} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {parseDiagnosticLogOptions, ZigbeeDiagnosticEventWriter, type DiagnosticLogOptions} from "./diagnostics.js";

export type EventCategory = "connection" | "device" | "command" | "progress" | "host";

export interface HostEvent {
  version: 1;
  id: number;
  timestamp: string;
  category: EventCategory;
  type: string;
  requestId?: string;
  data: unknown;
}

export function redactLogSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLogSecrets);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = /^(authorization|token|network_?key|install_?code)$/i.test(key) ? "[REDACTED]" : redactLogSecrets(child);
  }
  return result;
}

export function inferCategory(type: string): EventCategory {
  if (type.startsWith("command") || type.startsWith("get_") || type.startsWith("set_")) return "command";
  if (type.includes("progress") || type.includes("heartbeat") || type.startsWith("wait_")) return "progress";
  if (type.startsWith("device") || type === "state") return "device";
  if (type.startsWith("zigbee_diag.")) return "progress";
  if (type.startsWith("host") || type.startsWith("http")) return "host";
  return "connection";
}

function time(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {hour12: false});
}

function record(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

export function renderNarrative(event: HostEvent): string[] {
  const data = record(event.data);
  const prefix = `[${time(event.timestamp)}]`;
  const request = event.requestId ? ` [${event.requestId}]` : "";
  const line = (level: string, message: string): string => `${prefix} [${level.padEnd(5)}]${request} ${message}`;
  if (event.type.startsWith("command.observe.")) {
    return [line("WAIT", `Observation phase ${event.type.slice("command.".length)} for ${String(data.id)} on ${String(data.deviceId)}`)];
  }
  if (event.type.startsWith("command.effect.") && event.type.endsWith(".skipped")) {
    return [line("INFO", `Skipped non-critical side-effect verification for ${String(data.id)}: ${String(data.property)}=${JSON.stringify(data.expected)}`)];
  }
  if (event.type.startsWith("zigbee_service.")) {
    return [line("INFO", `${event.type}: ${String(data.device ?? data.deviceId ?? "")}${data.property ? ` ${String(data.property)}` : ""}${data.durationMs !== undefined ? ` (${String(data.durationMs)}ms)` : ""}`)];
  }
  if (event.type.startsWith("zigbee_warm.")) {
    return [line("INFO", `${event.type}: ${data.count !== undefined ? `${String(data.count)} target(s)` : String(data.deviceId ?? "")}${data.durationMs !== undefined ? ` (${String(data.durationMs)}ms)` : ""}`)];
  }
  if (event.type === "zigbee_diag.snapshot") {
    return [line("INFO", `Diagnostic snapshot captured ${String(data.count)} device(s) (${String(data.reason ?? "interval")})`)];
  }
  switch (event.type) {
    case "adapter_probe_started": return [line("INFO", `Probing Zigbee adapter on ${String(data.port)}...`)];
    case "adapter_found": return [
      line("OK", `Found Zigbee adapter — Ember ${String(data.firmware)}`),
      `                    EUI-64: ${String(data.eui64)}`,
    ];
    case "coordinator_connecting": return [line("INFO", `Opening coordinator connection on ${String(data.port)}...`)];
    case "coordinator_started": return [
      line("OK", `${data.result === "reset" ? "Fresh Zigbee network started" : "Zigbee network resumed"} on channel ${String(data.channel)}`),
      `                    PAN ID: ${String(data.panID)}  Extended PAN: ${String(data.extendedPanID)}`,
    ];
    case "coordinator_stopped": return [line("OK", "Coordinator connection closed cleanly")];
    case "permit_join": return [line(data.permitted ? "WAIT" : "OK", data.permitted ? `Joining is open${data.time ? ` for ${data.time}s` : ""}` : "Joining is closed")];
    case "join_wait_progress": return [line("WAIT", `Still listening for join announcements (${String(data.remainingSeconds)}s remaining; phase: ${String(data.phase ?? "waiting")})`)];
    case "watch_heartbeat": return [line("WAIT", `Watch is active; ${String(data.secondsSinceLastEvent)}s since the last device event`)];
    case "device_joined": return [line("FOUND", `Device announced itself: ${String(data.ieeeAddress)}`), `                    Network address: ${String(data.networkAddress)}`];
    case "device_interview": return [line(data.status === "failed" ? "ERROR" : data.status === "successful" ? "OK" : "INFO", data.status === "started" ? `Interviewing ${String(data.ieeeAddress)} and reading identity...` : `Device interview ${String(data.status)}${data.modelID ? ` — model ${String(data.modelID)}` : ""}`)];
    case "definition_resolved": return [
      line(data.generated ? "WARN" : "OK", data.generated ? "No exact device definition; using generated fallback" : `Matched ${String(data.vendor)} ${String(data.model)} — ${String(data.description)}`),
      ...(Array.isArray(data.capabilities) ? [`                    Capabilities: ${data.capabilities.join(", ")}`] : []),
    ];
    case "device_configuration_started": return [line("INFO", `Configuring ${String(data.model)} (${String(data.ieeeAddress)})...`)];
    case "device_configured": return [line("OK", `Device configuration completed for ${String(data.model)}`)];
    case "command_sending": return [line("INFO", `Sending ${String(data.property)}=${JSON.stringify(data.value)} to ${String(data.device)}...`)];
    case "command": return [line("OK", `Command accepted for ${String(data.device)}: ${String(data.property)}=${JSON.stringify(data.value)}`)];
    case "command_confirmed": return [line("OK", `Device confirmed ${String(data.property)}=${JSON.stringify(data.value)} via ${String(data.origin)}`)];
    case "command.http.received": return [line("INFO", `HTTP command received for ${String(data.deviceId)}/${String(data.componentId)}: ${String(data.action)}`)];
    case "command.public_state.source": return [line("INFO", `Public state source for ${String(data.deviceId)} via ${String(data.origin)}: ${JSON.stringify(data.payload)}`)];
    case "command.public_state.emitted": return [line("INFO", `Public state emitted for ${String(data.deviceId)}/${String(data.componentId)} via ${String(data.origin)}: ${JSON.stringify(data.patch)}`)];
    case "command.queued": return [line("QUEUE", `Queued ${String(data.id)} for ${String(data.deviceId)}: ${JSON.stringify(data.requested)}`)];
    case "command.pending_marked": return [line("INFO", `Pending state marked for ${String(data.id)} on ${String(data.deviceId)}`)];
    case "command.sending": return [line("SEND", `Sending ${String(data.id)} to ${String(data.deviceId)}`)];
    case "command.physical_send.start": return [line("SEND", `Physical send started for ${String(data.id)} on ${String(data.deviceId)}: ${String(data.property)}=${JSON.stringify(data.requested)}`)];
    case "command.physical_send.done": return [line("OK", `Physical send finished for ${String(data.id)} on ${String(data.deviceId)}: ${String(data.property)}=${JSON.stringify(data.requested)}`)];
    case "command.observing": return [line("WAIT", `Observing physical outcome for ${String(data.id)}`)];
    case "command.confirmed": return [line("OK", `Command ${String(data.id)} physically confirmed`)];
    case "command.unverifiable": return [line("WARN", `Command ${String(data.id)} was sent but the property is not observable`)];
    case "command.inconclusive": return [line("WARN", `Command ${String(data.id)} was sent without a matching observation before its deadline`)];
    case "command.failed": return [line("ERROR", `Command ${String(data.id)} failed: ${String(data.error)}`)];
    case "command.interrupted": return [line("WARN", `Command ${String(data.id)} was interrupted without being resent`)];
    case "coordinator.disconnected": return [line("ERROR", `Coordinator disconnected${data.port ? ` from ${String(data.port)}` : ""}; recovery started`)];
    case "reconnect.scheduled": return [line("WAIT", `Coordinator reconnect attempt ${String(data.attempt)} in ${Math.ceil(Number(data.delayMs) / 1000)}s`)];
    case "reconnect.attempt": return [line("INFO", `Looking for the coordinator (attempt ${String(data.attempt)})...`)];
    case "reconnect.failed": return [line("WARN", `Coordinator reconnect failed: ${String(data.message)}`)];
    case "coordinator.connected":
    case "coordinator.reconnected": return [line("OK", `Coordinator connected on ${String(data.port)} — ${String(data.eui64)}`)];
    case "device_reachability": {
      const reachability = record(data.reachability);
      return [line(reachability.status === "unreachable" ? "WARN" : "INFO", `${String(data.deviceId)} is ${String(reachability.status)}`)];
    }
    case "command_wait_progress": return [line("WAIT", `Waiting for device confirmation (${String(data.elapsedSeconds)}s elapsed)`)];
    case "state": return [line("INFO", data.origin === "optimistic" ? `Expected state for ${String(data.device)}: ${JSON.stringify(data.payload)}` : `State from ${String(data.device)} via ${String(data.origin)}: ${JSON.stringify(data.payload)}`)];
    case "host_started": return [line("OK", `Local Zigbee host ready at http://${String(data.address)}:${String(data.port)}`)];
    case "host_autostart": return [line("INFO", "Local Zigbee host is not running; starting it now...")];
    case "host_ready": return [line(data.coordinatorState === "connected" ? "OK" : "WARN", `Authenticated local Zigbee host is ready; coordinator ${String(data.coordinatorState)}`)];
    case "host_status": return [line("INFO", `Host status: ${String(data.status ?? (data.connected ? "ready" : "stopped"))}`)];
    case "adapter_status": return [line(data.connected ? "OK" : "WARN", `Adapter ${String(data.port ?? "not present")} is ${data.connected ? "connected" : "disconnected"} — ${String(data.firmware ?? "firmware unavailable")}`)];
    case "cli_log": return [line("INFO", `Run log: ${String(data.path)}`)];
    case "devices": {
      const devices = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>>
        : Array.isArray(data.devices) ? data.devices as Array<Record<string, unknown>> : [];
      return [line("OK", `Found ${devices.length} paired device${devices.length === 1 ? "" : "s"}`), ...devices.flatMap((device) => [
        `                    ${String(device.id ?? device.ieeeAddress)} — ${String(device.manufacturer ?? device.manufacturerName ?? "unknown")} ${String(device.model ?? device.modelID ?? "unknown")}`,
      ])];
    }
    case "command_result": {
      const command = record(data.command);
      return [line(command.status === "confirmed" ? "OK" : command.status === "queued" ? "QUEUE" : "WARN", `Command ${String(command.id)}: ${String(command.status)}`)];
    }
    case "command_status": {
      const command = record(data.command);
      const failure = record(command.failure);
      return [line(command.status === "confirmed" ? "OK" : command.status === "failed" ? "ERROR" : "INFO", `Command ${String(command.id)}: ${String(command.status)}${failure.code ? ` (${String(failure.code)})` : ""} — ${JSON.stringify(command.results ?? {})}`)];
    }
    case "commands": {
      const commands = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
      return [line("INFO", `${commands.length} retained command${commands.length === 1 ? "" : "s"}`), ...commands.map((command) => `                    ${String(command.id)} — ${String(command.status)} — ${String(command.deviceId)}`)];
    }
    case "read_result": return [line("OK", `Device refresh confirmed: ${JSON.stringify(data.values)}`)];
    case "device_configuration_failed": return [line("ERROR", `Device configuration failed for ${String(data.model)}: ${String(data.message)}`)];
    case "host_heartbeat": return [line("WAIT", `Host is healthy; coordinator ${String(data.connected ? "connected" : "disconnected")}`)];
    case "error": return [line("ERROR", `${String(data.context ?? "operation")}: ${String(data.message)}`)];
    default: return [line("INFO", `${event.type}: ${JSON.stringify(redactLogSecrets(event.data))}`)];
  }
}

export class HostEventHub {
  readonly #subscribers = new Set<(event: HostEvent) => void>();
  readonly #connectionLog: WriteStream;
  readonly #commandLog: WriteStream;
  readonly #diagnostics?: ZigbeeDiagnosticEventWriter;
  #id = 0;
  readonly streamId = randomUUID();
  readonly #journal: HostEvent[] = [];
  readonly #journalLimit: number;

  private constructor(connectionLog: WriteStream, commandLog: WriteStream, journalLimit: number, diagnostics?: ZigbeeDiagnosticEventWriter) {
    this.#connectionLog = connectionLog;
    this.#commandLog = commandLog;
    this.#journalLimit = journalLimit;
    this.#diagnostics = diagnostics;
  }

  static async create(logDirectory: string, journalLimit = 10_000, diagnosticOptions: DiagnosticLogOptions = parseDiagnosticLogOptions(process.env, logDirectory)): Promise<HostEventHub> {
    await mkdir(logDirectory, {recursive: true});
    const diagnostics = new ZigbeeDiagnosticEventWriter(diagnosticOptions);
    await diagnostics.init();
    const day = new Date().toISOString().slice(0, 10);
    return new HostEventHub(
      createWriteStream(path.join(logDirectory, `connection-${day}.log`), {flags: "a"}),
      createWriteStream(path.join(logDirectory, `commands-${day}.log`), {flags: "a"}),
      journalLimit,
      diagnostics,
    );
  }

  emit(type: string, data: unknown, requestId?: string, category = inferCategory(type)): HostEvent {
    const event: HostEvent = {version: 1, id: ++this.#id, timestamp: new Date().toISOString(), category, type, requestId, data: redactLogSecrets(data)};
    this.#journal.push(event);
    if (this.#journal.length > this.#journalLimit) this.#journal.splice(0, this.#journal.length - this.#journalLimit);
    const text = `${renderNarrative(event).join("\n")}\n`;
    (category === "command" || (category === "progress" && requestId) ? this.#commandLog : this.#connectionLog).write(text);
    this.#diagnostics?.write(event);
    for (const subscriber of this.#subscribers) subscriber(event);
    return event;
  }

  get sequence(): number { return this.#id; }

  replay(after: number): HostEvent[] | undefined {
    if (after < 0 || after > this.#id) return undefined;
    const oldest = this.#journal[0]?.id ?? this.#id + 1;
    if (after !== this.#id && after < oldest - 1) return undefined;
    return this.#journal.filter((event) => event.id > after);
  }

  subscribe(subscriber: (event: HostEvent) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  async close(): Promise<void> {
    await Promise.all([this.#end(this.#connectionLog), this.#end(this.#commandLog), this.#diagnostics?.close()]);
  }

  async #end(stream: WriteStream): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.end(resolve);
    });
  }
}
