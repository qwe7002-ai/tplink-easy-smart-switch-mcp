import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { SwitchConfig, SwitchEntry } from "./types.js";

export type { SwitchConfig, SwitchEntry };

export const CONFIG_PATH =
  process.env.TPLINK_CONFIG_PATH ?? join(homedir(), ".config", "tplink-mcp", "switches.json");

export function loadConfig(): SwitchConfig {
  if (!existsSync(CONFIG_PATH)) return { switches: [] };
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as SwitchConfig;
  } catch {
    return { switches: [] };
  }
}

export function saveConfig(config: SwitchConfig): void {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function resolveCredentials(
  host?: string,
  username?: string,
  password?: string,
): { host?: string; username?: string; password?: string } {
  if (host) return { host, username, password };

  const config = loadConfig();
  const entry = config.default
    ? config.switches.find((s) => s.name === config.default)
    : config.switches[0];

  if (!entry) return { host, username, password };

  return {
    host: entry.host,
    username: username ?? entry.username,
    password: password ?? entry.password,
  };
}

export function listSwitches(): SwitchEntry[] {
  return loadConfig().switches;
}

export function getDefaultSwitchName(): string | undefined {
  const config = loadConfig();
  return config.default ?? config.switches[0]?.name;
}
