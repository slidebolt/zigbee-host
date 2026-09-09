import type {AdapterTypes, Models} from "zigbee-herdsman";
import type {Definition} from "zigbee-herdsman-converters";

export interface NetworkFile {
  panID: number;
  extendedPanID: number[];
  networkKey: number[];
  channelList: number[];
}

export interface RuntimePaths {
  root: string;
  network: string;
  database: string;
  databaseBackup: string;
  coordinatorBackup: string;
  state: string;
  commands: string;
  adapterIdentity: string;
  deviceCatalog: string;
}

export interface DeviceInfo {
  ieeeAddress: string;
  networkAddress: number;
  type: string;
  interviewState: string;
  manufacturerName?: string;
  modelID?: string;
  definition?: {
    vendor: string;
    model: string;
    description: string;
    generated: boolean;
  };
  exposes: ExposedProperty[];
  reachability?: DeviceReachability;
}

export interface DeviceReachability {
  status: "unknown" | "reachable" | "unreachable";
  lastSeen?: string;
  lastSuccess?: string;
  reason?: string;
  lastFailure?: {at: string; code: string; phase: "send" | "read" | "observe"; detail: string};
}

export interface ExposedProperty {
  property: string;
  type: string;
  access: number;
  category?: string;
  endpoint?: string;
  unit?: string;
  values?: unknown[];
  valueMin?: number;
  valueMax?: number;
  valueStep?: number;
}

export type ComponentKind = "light" | "switch" | "sensor" | "binary_sensor" | "number" | "select" | "cover" | "lock" | "climate" | "fan" | "button" | "text";

export interface ComponentFeature {
  read: boolean;
  write: boolean;
  reports: boolean;
  unit?: string;
  values?: unknown[];
  minimum?: number;
  maximum?: number;
  step?: number;
}

export interface HostComponent {
  id: string;
  kind: ComponentKind;
  name: string;
  endpoint?: string;
  revision: number;
  features: Record<string, ComponentFeature>;
  state: Record<string, unknown>;
}

export interface HostDevice extends ApiDeviceSummary {
  name: string;
  description?: string;
  available: boolean;
  components: HostComponent[];
}

export interface DeviceCapability {
  name: string;
  type: string;
  access: {
    read: boolean;
    write: boolean;
    reports: boolean;
  };
  endpoint?: string;
  unit?: string;
  values?: unknown[];
  minimum?: number;
  maximum?: number;
  step?: number;
}

export interface ApiDeviceSummary {
  id: string;
  manufacturer?: string;
  model?: string;
  kind: string;
  interview: string;
  reachability: DeviceReachability;
}

export interface ApiDevice extends ApiDeviceSummary {
  description?: string;
  network: {
    address: number;
    kind: string;
  };
  definition?: {
    vendor: string;
    model: string;
    generated: boolean;
  };
  capabilities: DeviceCapability[];
}

export interface ResolvedDevice {
  device: Models.Device;
  definition: Definition;
}

export interface ProbeResult {
  port: string;
  protocolVersion: number;
  stackType: number;
  stackVersion: number;
  firmware: string;
  firmwareMeta: Record<string, number | string>;
  eui64: string;
  meetsRecommendedFirmware: boolean;
  supportedByHost: boolean;
}

export interface AdapterIdentity {
  eui64: string;
  lastPort: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface CoordinatorStartInfo {
  result: "resumed" | "reset" | "restored";
  createdNetworkConfig: boolean;
  firmware: string;
  panID: number;
  extendedPanID: string;
  channel: number;
  nwkUpdateID: number;
}

export type StateOrigin = "device" | "read-response" | "optimistic";

export interface StateEvent {
  device: string;
  modelID?: string;
  payload: Record<string, unknown>;
  state: Record<string, unknown>;
  origin: StateOrigin;
}

export type CommandStatus = "queued" | "sending" | "observing" | "confirmed" | "unverifiable" | "inconclusive" | "failed" | "interrupted";
export type ObservationMode = "readback" | "passive";

export interface CommandPropertyResult {
  status: "confirmed" | "unverifiable" | "inconclusive" | "failed";
  requested: unknown;
  expected?: unknown;
  observed?: unknown;
  origin?: StateOrigin;
  detail?: string;
}

export interface DeviceCommand {
  id: string;
  deviceId: string;
  status: CommandStatus;
  requested: Record<string, unknown>;
  endpoints?: Record<string, string>;
  observationMode?: ObservationMode;
  expected?: Record<string, unknown>;
  results: Record<string, CommandPropertyResult>;
  timeline?: Record<string, string>;
  observationTimeoutMs: number;
  createdAt: string;
  updatedAt: string;
  sendingAt?: string;
  sentAt?: string;
  completedAt?: string;
  error?: string;
  failure?: {code: string; phase: "send" | "read" | "observe"; retryable: boolean; detail: string};
}

export interface SetResult {
  state: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export type CoordinatorVersion = AdapterTypes.CoordinatorVersion;
