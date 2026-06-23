export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function firstString(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

export function numberToBool(value: unknown): boolean | null {
  const n = asNumber(value);
  return n === null ? null : n === 1;
}

export function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function valueAt(value: unknown, index: number): number | null {
  return Array.isArray(value) && typeof value[index] === "number" ? value[index] : null;
}

export function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

export function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function maxInputPort(ports: number[]): number {
  return Math.max(0, ...ports.filter((p) => Number.isInteger(p) && p > 0));
}

// JS bitwise ops are 32-bit signed; cap at 32 to avoid wrap-around for large port counts.
export function bitmaskToPorts(mask: number | null | undefined, portCount: number | null | undefined): number[] {
  if (typeof mask !== "number" || !Number.isFinite(mask)) return [];
  const count = Math.min(portCount ?? 32, 32);
  const ports = [];
  for (let port = 1; port <= count; port += 1) {
    if ((mask & (1 << (port - 1))) !== 0) ports.push(port);
  }
  return ports;
}

export function portsToBitmask(ports: number[]): number {
  return uniqueNumbers(ports).reduce((mask, port) => mask | (1 << (port - 1)), 0);
}

export function portType(code: number | null): string {
  if (code === 0) return "rj45";
  if (code === 1) return "sfp";
  return `unknown(${code})`;
}

export function parsePortList(value: string | undefined): number[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
}

export function parseSetDeleteMode(value: string | undefined): "set" | "delete" {
  if (value === undefined || value === "" || value === "set") return "set";
  if (value === "delete") return "delete";
  throw new Error('mode must be "set" or "delete".');
}

export function buildPorts(raw: Record<string, unknown>, maxPortNum: number): Array<Record<string, unknown>> {
  const count = Math.max(0, maxPortNum);
  const out: Array<Record<string, unknown>> = [];

  for (let index = 0; index < count; index += 1) {
    out.push({
      port: index + 1,
      enabled: valueAt(raw.state, index) === 1,
      configured_speed_code: valueAt(raw.spd_cfg, index),
      actual_speed_code: valueAt(raw.spd_act, index),
      flow_control_configured: valueAt(raw.fc_cfg, index),
      flow_control_actual: valueAt(raw.fc_act, index),
      type: portType(valueAt(raw.port_type, index)),
      poe: valueAt(raw.is_poe_port, index) === 1,
      uplink: valueAt(raw.is_uplink, index) === 1,
      rx_mbps: valueAt(raw.rx_rate, index),
      tx_mbps: valueAt(raw.tx_rate, index),
    });
  }

  return out;
}

export function findParsedVlan(vlan: Record<string, unknown> | null, vid: number): Record<string, unknown> | null {
  const vlans = Array.isArray(vlan?.vlans) ? vlan.vlans : [];
  for (const item of vlans) {
    if (isRecord(item) && item.vid === vid) return item;
  }
  return null;
}

export function findParsedMembership(
  page: Record<string, unknown> | null,
  vid: number,
): Record<string, unknown> | null {
  const memberships = Array.isArray(page?.membership) ? page.membership : [];
  for (const item of memberships) {
    if (isRecord(item) && item.vid === vid) return item;
  }
  return null;
}

