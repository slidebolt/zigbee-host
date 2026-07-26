import type {ComponentFeature, ComponentKind, DeviceInfo, HostComponent, HostDevice} from "./types.js";

const ACCESS_STATE = 0b001;
const ACCESS_SET = 0b010;
const ACCESS_GET = 0b100;

const groupedKinds = new Set<ComponentKind>(["light", "switch", "cover", "lock", "climate", "fan"]);

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
}

function kindFor(type: string, writable: boolean, category?: string): ComponentKind {
  if (category && groupedKinds.has(category as ComponentKind)) return category as ComponentKind;
  if (type === "binary") return writable ? "switch" : "binary_sensor";
  if (type === "numeric") return writable ? "number" : "sensor";
  if (type === "enum") return writable ? "select" : "sensor";
  if (type === "text") return writable ? "text" : "sensor";
  return writable ? "button" : "sensor";
}

export function canonicalProperty(property: string, category?: string): string {
  if (property === "state" && category === "lock") return "locked";
  if (["speed", "speed_percent", "percentage"].includes(property) && category === "fan") return "percentage";
  switch (property) {
    case "state": return "power";
    case "position": return "position";
    case "current_heating_setpoint":
    case "occupied_heating_setpoint": return "temperature";
    case "system_mode": return "hvac_mode";
    case "local_temperature": return "current_temperature";
    default: return property;
  }
}

function feature(expose: DeviceInfo["exposes"][number]): ComponentFeature {
  return {
    read: (expose.access & ACCESS_GET) !== 0,
    write: (expose.access & ACCESS_SET) !== 0,
    reports: (expose.access & ACCESS_STATE) !== 0,
    ...(expose.unit === undefined ? {} : {unit: expose.unit}),
    ...(expose.values === undefined ? {} : {values: expose.values}),
    ...(expose.valueMin === undefined ? {} : {minimum: expose.valueMin}),
    ...(expose.valueMax === undefined ? {} : {maximum: expose.valueMax}),
    ...(expose.valueStep === undefined ? {} : {step: expose.valueStep}),
  };
}

function stateValue(state: Record<string, unknown>, property: string, endpoint?: string): unknown {
  if (endpoint && state[`${property}_${endpoint}`] !== undefined) return state[`${property}_${endpoint}`];
  return state[property];
}

export function normalizeComponents(device: DeviceInfo, state: Record<string, unknown> = {}): HostComponent[] {
  const groups = new Map<string, HostComponent>();
  for (const expose of device.exposes) {
    const writable = (expose.access & ACCESS_SET) !== 0;
    const kind = kindFor(expose.type, writable, expose.category);
    const grouped = groupedKinds.has(kind);
    const role = grouped ? kind : expose.property;
    const id = `${slug(expose.endpoint ?? "default")}-${slug(role)}`;
    let component = groups.get(id);
    if (!component) {
      component = {
        id,
        kind,
        name: role.replaceAll("_", " "),
        ...(expose.endpoint ? {endpoint: expose.endpoint} : {}),
        revision: 1,
        features: {},
        state: {},
      };
      groups.set(id, component);
    }
    const canonical = canonicalProperty(expose.property, expose.category);
    component.features[canonical] = feature(expose);
    const value = stateValue(state, expose.property, expose.endpoint);
    if (value !== undefined) component.state[canonical] = value;
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeDevice(device: DeviceInfo, state: Record<string, unknown> = {}): HostDevice {
  const manufacturer = device.definition?.vendor || device.manufacturerName;
  const model = device.definition?.model || device.modelID;
  return {
    id: device.ieeeAddress,
    name: [manufacturer, model].filter(Boolean).join(" ") || device.ieeeAddress,
    ...(manufacturer ? {manufacturer} : {}),
    ...(model ? {model} : {}),
    ...(device.definition?.description ? {description: device.definition.description} : {}),
    kind: device.type.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
    interview: device.interviewState.toLowerCase(),
    reachability: device.reachability ?? {status: "unknown"},
    available: device.reachability?.status === "reachable",
    components: normalizeComponents(device, state),
  };
}

export function commandValues(component: HostComponent, action: string, parameters: Record<string, unknown>): Record<string, unknown> {
  const writable = (name: string): void => {
    if (!component.features[name]?.write) throw new Error(`Component ${component.id} does not support ${name}`);
  };
  const binaryTarget = (): {name: string; on: unknown; off: unknown} => {
    const name = component.features.power?.write
      ? "power"
      : Object.keys(component.features).find((candidate) => component.features[candidate]?.write);
    if (!name) throw new Error(`Component ${component.id} has no writable binary value`);
    const values = component.features[name]?.values ?? [];
    const stringValues = values.filter((value): value is string => typeof value === "string");
    const on = stringValues.find((value) => ["on", "open", "true", "lock", "locked"].includes(value.toLowerCase())) ?? true;
    const off = stringValues.find((value) => ["off", "close", "closed", "false", "unlock", "unlocked"].includes(value.toLowerCase())) ?? false;
    return {name, on, off};
  };
  const binaryCommand = (mode: "on" | "off" | "toggle"): Record<string, unknown> => {
    const target = binaryTarget();
    const current = component.state[target.name];
    const value = mode === "on" ? target.on : mode === "off" ? target.off : current === target.on ? target.off : target.on;
    return {[target.name === "power" ? "state" : target.name]: value};
  };
  switch (action) {
    case "turn_on": return binaryCommand("on");
    case "turn_off": return binaryCommand("off");
    case "toggle": return binaryCommand("toggle");
    case "set_brightness": writable("brightness"); return {brightness: parameters.brightness};
    case "set_color_temp": writable("color_temp"); return {color_temp: parameters.temperature, ...(parameters.brightness ? {brightness: parameters.brightness} : {})};
    case "set_rgb": return {color: {r: parameters.r, g: parameters.g, b: parameters.b}, ...(parameters.brightness ? {brightness: parameters.brightness} : {})};
    case "set_hs": return {color: {h: parameters.hue, s: parameters.saturation}, ...(parameters.brightness ? {brightness: parameters.brightness} : {})};
    case "set_xy": return {color: {x: parameters.x, y: parameters.y}, ...(parameters.brightness ? {brightness: parameters.brightness} : {})};
    case "set_effect": writable("effect"); return {effect: parameters.effect};
    case "set_position": writable("position"); return {position: parameters.position};
    case "lock": writable("locked"); return {state: "LOCK"};
    case "unlock": writable("locked"); return {state: "UNLOCK"};
    case "set_speed": {
      const name = ["percentage", "speed", "speed_percent"].find((candidate) => component.features[candidate]?.write);
      if (!name) throw new Error(`Component ${component.id} does not support speed`);
      return {[name]: parameters.percentage};
    }
    case "set_temperature": return {occupied_heating_setpoint: parameters.temperature};
    case "set_hvac_mode": return {system_mode: parameters.mode};
    case "set_value": {
      const name = Object.keys(component.features).find((candidate) => component.features[candidate]?.write);
      if (!name) throw new Error(`Component ${component.id} has no writable value`);
      const original = name === "power" ? "state" : name;
      return {[original]: parameters.value};
    }
    case "select_option": {
      const name = Object.keys(component.features).find((candidate) => component.features[candidate]?.write);
      if (!name) throw new Error(`Component ${component.id} has no writable option`);
      return {[name]: parameters.option};
    }
    case "press": {
      const name = Object.keys(component.features).find((candidate) => component.features[candidate]?.write);
      if (!name) throw new Error(`Component ${component.id} is not pressable`);
      return {[name]: parameters.value ?? "ON"};
    }
    default: throw new Error(`Unsupported component action ${action}`);
  }
}
