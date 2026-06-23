/**
 * Reach an Easy Smart switch that sits on the same Layer-2 segment but a
 * different IP subnet (for example a switch fixed at 10.18.18.251 while your
 * computer is on 192.168.x.x).
 *
 * These newer cloud-managed SE-series switches do not answer the legacy
 * Easy Smart UDP discovery utility, and a foreign-subnet source IP cannot work
 * because the switch has no route to send its replies back. The reliable method
 * is to give your own NIC a temporary secondary IP inside the switch's subnet,
 * so ARP resolves the switch directly on-link and plain HTTP works. This script
 * computes and (with --apply) installs that temporary address, verifies the
 * switch is reachable, and removes the address again afterwards.
 *
 * Usage:
 *   bun run scripts/reach.ts [target] [options]
 *
 *   target            Switch IP (default 10.18.18.251)
 *
 * Options:
 *   --alias <ip>      Secondary IP to add to your NIC (default <net>.250)
 *   --prefix <n>      Subnet prefix length (default 24)
 *   --iface <name>    Network interface to use (auto-detected if omitted)
 *   --apply           Actually add the address (needs sudo / Administrator).
 *                     Without this flag the script only prints the commands.
 *   --keep            Leave the address in place instead of cleaning up on exit.
 *   -- <cmd...>       Run a command while the address is up, then clean up.
 *
 * Examples:
 *   bun run scripts/reach.ts                       # print what it would do
 *   sudo bun run scripts/reach.ts --apply          # bring up alias, wait for Ctrl-C
 *   sudo bun run scripts/reach.ts --apply -- bun run tui
 */

import os from "node:os";
import { spawn } from "node:child_process";
import { tcpOpen } from "../src/http.js";

interface Options {
  target: string;
  alias?: string;
  prefix: number;
  iface?: string;
  apply: boolean;
  keep: boolean;
  command: string[];
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { target: "10.18.18.251", prefix: 24, apply: false, keep: false, command: [] };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") { opts.command = argv.slice(i + 1); break; }
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--alias") opts.alias = argv[++i];
    else if (arg === "--iface") opts.iface = argv[++i];
    else if (arg === "--prefix") opts.prefix = Number(argv[++i]);
    else if (arg?.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (arg) positional.push(arg);
  }

  if (positional[0]) opts.target = positional[0];
  return opts;
}

function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${ip}`);
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`Invalid IPv4 address: ${ip}`);
    value = value * 256 + n;
  }
  return value >>> 0;
}

function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function prefixToMask(prefix: number): string {
  if (prefix < 1 || prefix > 31) throw new Error(`Unsupported prefix length: ${prefix}`);
  return intToIp((0xffffffff << (32 - prefix)) >>> 0);
}

// Pick a host address in the target's subnet that is not the network address,
// the broadcast address, or the switch itself. Defaults toward .250 and walks
// down so it rarely collides with low-numbered DHCP ranges.
export function chooseAlias(target: string, prefix: number, requested?: string): string {
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const targetInt = ipToInt(target);
  const network = (targetInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  if (requested) {
    const aliasInt = ipToInt(requested);
    if ((aliasInt & mask) >>> 0 !== network) throw new Error(`${requested} is not in the ${intToIp(network)}/${prefix} subnet.`);
    if (aliasInt === targetInt) throw new Error(`Alias ${requested} must differ from the switch IP.`);
    if (aliasInt === network || aliasInt === broadcast) throw new Error(`Alias ${requested} is the network or broadcast address.`);
    return requested;
  }

  for (let candidate = broadcast - 1; candidate > network; candidate -= 1) {
    if (candidate !== targetInt) return intToIp(candidate >>> 0);
  }
  throw new Error("Could not find a free host address in the subnet.");
}

function detectInterface(requested?: string): string {
  const interfaces = os.networkInterfaces();
  if (requested) {
    if (!interfaces[requested]) throw new Error(`Interface ${requested} was not found.`);
    return requested;
  }
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (addrs?.some((addr) => addr.family === "IPv4" && !addr.internal)) return name;
  }
  throw new Error("Could not auto-detect a network interface; pass --iface.");
}

function buildCommands(platform: NodeJS.Platform, iface: string, alias: string, prefix: number): { add: string[]; remove: string[] } {
  const mask = prefixToMask(prefix);
  switch (platform) {
    case "linux":
      return {
        add: ["ip", "addr", "add", `${alias}/${prefix}`, "dev", iface],
        remove: ["ip", "addr", "del", `${alias}/${prefix}`, "dev", iface],
      };
    case "darwin":
      return {
        add: ["ifconfig", iface, "alias", alias, "netmask", mask],
        remove: ["ifconfig", iface, "-alias", alias],
      };
    case "win32":
      return {
        add: ["netsh", "interface", "ipv4", "add", "address", `name=${iface}`, `address=${alias}`, `mask=${mask}`],
        remove: ["netsh", "interface", "ipv4", "delete", "address", `name=${iface}`, `address=${alias}`],
      };
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

function quote(parts: string[]): string {
  return parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

function run(parts: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(parts[0]!, parts.slice(1), { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function waitReachable(host: string, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await tcpOpen(host, 80)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const iface = detectInterface(opts.iface);
  const alias = chooseAlias(opts.target, opts.prefix, opts.alias);
  const { add, remove } = buildCommands(process.platform, iface, alias, opts.prefix);

  console.log(`Target switch : ${opts.target}`);
  console.log(`Interface     : ${iface}`);
  console.log(`Helper address: ${alias}/${opts.prefix}`);
  console.log("");

  if (await tcpOpen(opts.target, 80)) {
    console.log(`${opts.target}:80 is already reachable — no helper address needed.`);
    return;
  }

  if (!opts.apply) {
    console.log("The switch is not reachable yet. To bring it on-link, run:");
    console.log(`  add:    ${quote(add)}`);
    console.log(`  remove: ${quote(remove)}`);
    console.log("");
    console.log("Then access it, for example:");
    console.log(`  bun run src/index.ts        # MCP server, then use host "${opts.target}"`);
    console.log(`  bun run scripts/capture.ts --host ${opts.target} --username admin --password ...`);
    console.log("");
    console.log("Re-run this script with --apply to perform the add/remove automatically (needs sudo / Administrator).");
    return;
  }

  console.log(`Adding ${alias}/${opts.prefix} to ${iface} ...`);
  const addCode = await run(add);
  if (addCode !== 0) {
    console.error(`Failed to add the helper address (exit ${addCode}). Try running with sudo / as Administrator.`);
    process.exit(addCode);
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned || opts.keep) return;
    cleaned = true;
    console.log(`\nRemoving ${alias}/${opts.prefix} from ${iface} ...`);
    await run(remove).catch(() => undefined);
  };
  process.on("SIGINT", () => { void cleanup().then(() => process.exit(130)); });
  process.on("SIGTERM", () => { void cleanup().then(() => process.exit(143)); });

  try {
    const reachable = await waitReachable(opts.target);
    console.log(reachable
      ? `${opts.target}:80 is now reachable.`
      : `Warning: ${opts.target}:80 still did not respond. Check cabling and that the switch IP is really ${opts.target}.`);

    if (opts.command.length > 0) {
      console.log(`Running: ${quote(opts.command)}`);
      await run(opts.command).catch(() => undefined);
    } else if (!opts.keep) {
      console.log("Helper address is up. Press Ctrl-C to remove it and exit.");
      await new Promise(() => {}); // Wait until a signal triggers cleanup.
    }
  } finally {
    await cleanup();
  }

  if (opts.keep) {
    console.log(`Left ${alias}/${opts.prefix} in place. Remove it later with:`);
    console.log(`  ${quote(remove)}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
