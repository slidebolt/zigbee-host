import type {Models} from "zigbee-herdsman";
import type {Definition, Expose} from "zigbee-herdsman-converters";
import type {ExposedProperty} from "./types.js";

type ExposeLike = Expose & {
  property?: string;
  endpoint?: string;
  unit?: string;
  values?: unknown[];
  value_min?: number;
  value_max?: number;
  value_step?: number;
  features?: ExposeLike[];
};

export function flattenExposes(definition: Definition, device: Models.Device): ExposedProperty[] {
  const roots = typeof definition.exposes === "function" ? definition.exposes(device, {}) : definition.exposes;
  const result: ExposedProperty[] = [];

  const visit = (expose: ExposeLike, inheritedEndpoint?: string, inheritedCategory?: string): void => {
    const endpoint = expose.endpoint ?? inheritedEndpoint;
    const category = inheritedCategory ?? expose.type;
    if (expose.property) {
      result.push({
        property: expose.property,
        type: expose.type,
        access: expose.access,
        category,
        endpoint,
        unit: expose.unit,
        values: expose.values,
        valueMin: expose.value_min,
        valueMax: expose.value_max,
        valueStep: expose.value_step,
      });
    }
    for (const feature of expose.features ?? []) visit(feature, endpoint, category);
  };

  for (const expose of roots) visit(expose as ExposeLike);
  return result.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.property === item.property && candidate.endpoint === item.endpoint) === index,
  );
}

export function parseValue(raw: string): unknown {
  const normalized = raw.trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return Number(normalized);
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (normalized === "null") return null;
  if ((normalized.startsWith("{") && normalized.endsWith("}")) || (normalized.startsWith("[") && normalized.endsWith("]"))) {
    return JSON.parse(normalized) as unknown;
  }
  return raw;
}

export function firmwareAtLeast(meta: Record<string, number | string>, required: [number, number, number]): boolean {
  const actual = [Number(meta.major), Number(meta.minor), Number(meta.patch)];
  if (actual.some(Number.isNaN)) return false;
  for (let index = 0; index < required.length; index++) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}
