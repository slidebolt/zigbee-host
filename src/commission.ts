import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {archiveDataDirectory} from "./archive.js";
import {runtimePaths} from "./config.js";
import type {ManagedZigbeeRuntime} from "./runtime-manager.js";
import type {CoordinatorStartInfo, DeviceInfo, ProbeResult, StateEvent} from "./types.js";
import {ZigbeeService} from "./zigbee-service.js";

const EXPECTED_MODEL = "E11-N1EA";
const REQUIRED_PROPERTIES = ["state", "brightness", "color_temp", "color", "x", "y", "power", "energy"];
const RADIO_TIMEOUT_MS = 12_000;

export type CommissionFailure = "pairing" | "unsupported-device" | "control" | "persistence" | "unexpected";

export class CommissionError extends Error {
  readonly exitCode: number;
  readonly category: CommissionFailure;

  constructor(category: CommissionFailure, message: string, cause?: unknown) {
    super(message, {cause});
    this.name = "CommissionError";
    this.category = category;
    this.exitCode = {pairing: 3, "unsupported-device": 4, control: 5, persistence: 6, unexpected: 1}[category];
  }
}

export interface CommissionStep {
  name: string;
  status: "passed" | "failed";
  timestamp: string;
  details?: unknown;
  error?: string;
}

export interface CommissionReport {
  schemaVersion: 1;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed";
  archive?: string;
  adapter?: ProbeResult;
  network?: Omit<CoordinatorStartInfo, "firmware" | "createdNetworkConfig">;
  device?: DeviceInfo;
  steps: CommissionStep[];
  failure?: {category: CommissionFailure; message: string};
}

export interface CommissionOptions {
  dataDirectory?: string;
  seconds?: number;
  output: (event: string, data: unknown) => void;
  signal?: AbortSignal;
  probeAdapter: () => Promise<ProbeResult>;
  createRuntime: () => ManagedZigbeeRuntime;
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = /^(network_?key|install_?code)$/i.test(key) ? "[REDACTED]" : redactSecrets(child);
  }
  return result;
}

export async function writeCommissionReport(dataDirectory: string, report: CommissionReport): Promise<string> {
  await mkdir(dataDirectory, {recursive: true});
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const destination = path.join(dataDirectory, `commission-report-${stamp}.json`);
  await writeFile(destination, `${JSON.stringify(redactSecrets(report), null, 2)}\n`, "utf8");
  return destination;
}

export function commissionValueMatches(actual: unknown, expected: unknown, tolerance = 0): boolean {
  if (typeof expected === "number" && typeof actual === "number") return Math.abs(actual - expected) <= tolerance;
  if (typeof expected === "object" && expected && typeof actual === "object" && actual) {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    return Object.entries(expectedRecord).every(([key, value]) =>
      typeof value === "number" && typeof actualRecord[key] === "number"
        ? Math.abs((actualRecord[key] as number) - value) <= tolerance
        : actualRecord[key] === value,
    );
  }
  return actual === expected;
}

export function validateCommissionDevice(device: DeviceInfo): string[] {
  const issues: string[] = [];
  if (device.modelID !== EXPECTED_MODEL) issues.push(`modelID must be ${EXPECTED_MODEL}`);
  if (device.interviewState !== "SUCCESSFUL") issues.push("interview must be SUCCESSFUL");
  if (!device.definition) issues.push("definition is missing");
  else {
    if (device.definition.generated) issues.push("definition must not be generated");
    if (device.definition.vendor !== "Sengled") issues.push("definition vendor must be Sengled");
    if (device.definition.model !== EXPECTED_MODEL) issues.push(`definition model must be ${EXPECTED_MODEL}`);
  }
  const exposed = new Set(device.exposes.map((item) => item.property));
  const missing = REQUIRED_PROPERTIES.filter((property) => !exposed.has(property));
  if (missing.length > 0) issues.push(`missing capabilities: ${missing.join(", ")}`);
  return issues;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runCommission(options: CommissionOptions): Promise<{report: CommissionReport; reportPath: string}> {
  const startedAt = new Date().toISOString();
  const paths = runtimePaths(options.dataDirectory);
  const report: CommissionReport = {schemaVersion: 1, startedAt, status: "running", steps: []};
  const seconds = options.seconds ?? 180;
  let service: ZigbeeService | undefined;
  let manager: ManagedZigbeeRuntime | undefined;
  let reportPath = "";

  const pass = (name: string, details?: unknown): void => {
    const step: CommissionStep = {name, status: "passed", timestamp: new Date().toISOString(), details};
    report.steps.push(step);
    options.output("commission_step", step);
  };

  const fail = (name: string, error: unknown): void => {
    const step: CommissionStep = {name, status: "failed", timestamp: new Date().toISOString(), error: serializeError(error)};
    report.steps.push(step);
    options.output("commission_step", step);
  };


  const confirmRead = async (
    active: ZigbeeService,
    ieeeAddress: string,
    property: string,
    expected: unknown,
    tolerance = 0,
  ): Promise<StateEvent> => {
    const waiting = active.waitForState(
      ieeeAddress,
      property,
      (actual) => commissionValueMatches(actual, expected, tolerance),
      RADIO_TIMEOUT_MS,
    );
    await Promise.all([waiting, active.get(ieeeAddress, property)]);
    return await waiting;
  };

  const setAndConfirm = async (
    active: ZigbeeService,
    ieeeAddress: string,
    property: string,
    value: unknown,
    tolerance = 0,
  ): Promise<StateEvent> => {
    await active.set(ieeeAddress, property, value);
    await delay(300);
    return await confirmRead(active, ieeeAddress, property, value, tolerance);
  };

  try {
    options.signal?.throwIfAborted();
    report.adapter = await options.probeAdapter();
    if (!report.adapter.supportedByHost || !report.adapter.meetsRecommendedFirmware) {
      throw new CommissionError("unsupported-device", `Coordinator firmware ${report.adapter.firmware} is not supported`);
    }
    pass("adapter-probe", {firmware: report.adapter.firmware, protocolVersion: report.adapter.protocolVersion, eui64: report.adapter.eui64});

    report.archive = await archiveDataDirectory(paths.root);
    pass("archive-existing-data", {archive: report.archive ?? "no existing data"});

    manager = options.createRuntime();
    service = manager.gateway;
    const initialStart = await manager.start();
    report.network = {
      result: initialStart.result,
      panID: initialStart.panID,
      extendedPanID: initialStart.extendedPanID,
      channel: initialStart.channel,
      nwkUpdateID: initialStart.nwkUpdateID,
    };
    if (initialStart.result !== "reset" || !initialStart.createdNetworkConfig) {
      throw new CommissionError("persistence", `Fresh coordinator start returned '${initialStart.result}' instead of 'reset'`);
    }
    if ((await service.listDevices()).length !== 0) {
      throw new CommissionError("persistence", "Fresh device database is not empty");
    }
    pass("fresh-network", report.network);

    await service.permitJoin(seconds);
    options.output("pairing_instructions", {
      model: EXPECTED_MODEL,
      seconds,
      instructions: [
        "Use a normal toggle switch or power strip, not a dimmer or three-way lamp.",
        "Rapidly switch the bulb OFF and ON at least 10 times, ending ON.",
        "Five flashes confirm factory reset and pairing mode; leave it powered ON.",
      ],
    });

    let device: DeviceInfo;
    try {
      const pairing = service.waitForDevice(() => true, seconds * 1000);
      const interrupted = new Promise<never>((_resolve, reject) => {
        if (options.signal?.aborted) reject(new CommissionError("pairing", "Commissioning was interrupted"));
        options.signal?.addEventListener(
          "abort",
          () => reject(new CommissionError("pairing", "Commissioning was interrupted")),
          {once: true},
        );
      });
      device = await Promise.race([pairing, interrupted]);
    } catch (error) {
      if (error instanceof CommissionError) throw error;
      throw new CommissionError("pairing", `No successfully interviewed device joined within ${seconds} seconds`, error);
    } finally {
      await service.closeJoin().catch(() => undefined);
    }

    report.device = device;
    const deviceIssues = validateCommissionDevice(device);
    if (deviceIssues.length > 0) throw new CommissionError("unsupported-device", deviceIssues.join("; "));
    const exposed = new Set(device.exposes.map((item) => item.property));
    pass("pair-interview-configure", {ieeeAddress: device.ieeeAddress, definition: device.definition, exposes: [...exposed].sort()});

    const controls: Array<[string, unknown, number?]> = [
      ["state", "ON"],
      ["state", "OFF"],
      ["state", "ON"],
      ["brightness", 64, 2],
      ["brightness", 200, 2],
      ["color_temp", 370, 3],
      ["color_temp", 250, 3],
      ["color", {x: 0.7006, y: 0.2993}, 0.02],
      ["color_temp", 370, 3],
      ["brightness", 200, 2],
      ["state", "ON"],
    ];
    try {
      for (const [property, value, tolerance] of controls) {
        if (options.signal?.aborted) throw new CommissionError("unexpected", "Commissioning was interrupted");
        const event = await setAndConfirm(service, device.ieeeAddress, property, value, tolerance);
        pass(`control-${property}-${JSON.stringify(value)}`, {reported: event.payload[property], origin: event.origin});
      }
      for (const property of ["power", "energy"]) {
        if (options.signal?.aborted) throw new CommissionError("unexpected", "Commissioning was interrupted");
        const waiting = service.waitForState(device.ieeeAddress, property, (value) => typeof value === "number", RADIO_TIMEOUT_MS);
        await Promise.all([waiting, service.get(device.ieeeAddress, property)]);
        const event = await waiting;
        pass(`meter-${property}`, {reported: event.payload[property], origin: event.origin});
      }
    } catch (error) {
      throw new CommissionError("control", `Device control verification failed: ${serializeError(error)}`, error);
    }

    if (options.signal?.aborted) throw new CommissionError("unexpected", "Commissioning was interrupted");
    await manager.stop();
    manager = options.createRuntime();
    service = manager.gateway;
    const resumed = await manager.start();
    if (
      resumed.result !== "resumed" ||
      resumed.panID !== initialStart.panID ||
      resumed.extendedPanID !== initialStart.extendedPanID ||
      resumed.channel !== initialStart.channel
    ) {
      throw new CommissionError("persistence", "Coordinator did not resume the same network identity");
    }
    const resumedDevice = (await service.listDevices()).find((candidate) => candidate.ieeeAddress === device.ieeeAddress);
    if (!resumedDevice?.definition || resumedDevice.definition.generated || resumedDevice.definition.model !== EXPECTED_MODEL) {
      throw new CommissionError("persistence", "Paired device or exact converter was not retained after restart");
    }
    const retainedState = await service.getCachedState(device.ieeeAddress);
    if (
      retainedState.state !== "ON" ||
      !commissionValueMatches(retainedState.brightness, 200, 2) ||
      !commissionValueMatches(retainedState.color_temp, 370, 3)
    ) {
      throw new CommissionError("persistence", "Normalized ON/brightness/color-temperature state was not retained after restart");
    }
    try {
      await setAndConfirm(service, device.ieeeAddress, "state", "OFF");
      await setAndConfirm(service, device.ieeeAddress, "state", "ON");
    } catch (error) {
      throw new CommissionError("persistence", `Post-restart control failed: ${serializeError(error)}`, error);
    }
    await manager.stop();
    manager = undefined;
    service = undefined;
    pass("restart-resume-control", {result: resumed.result, ieeeAddress: device.ieeeAddress, retainedState, finalState: "ON"});

    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    reportPath = await writeCommissionReport(paths.root, report);
    options.output("commission_passed", {reportPath, ieeeAddress: device.ieeeAddress});
    return {report, reportPath};
  } catch (error) {
    const commissionError = error instanceof CommissionError ? error : new CommissionError("unexpected", serializeError(error), error);
    fail("commission", commissionError);
    report.status = "failed";
    report.failure = {category: commissionError.category, message: commissionError.message};
    report.finishedAt = new Date().toISOString();
    reportPath = await writeCommissionReport(paths.root, report);
    options.output("commission_failed", {reportPath, category: commissionError.category, message: commissionError.message});
    throw commissionError;
  } finally {
    if (service) {
      try {
        await service.closeJoin();
      } catch {
        // The service may already be stopped after the restart checkpoint.
      }
      await manager?.stop().catch(() => undefined);
    }
  }
}
