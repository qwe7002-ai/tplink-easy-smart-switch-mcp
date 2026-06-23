import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SwitchClient } from "./client.js";
import { analyzeTopology } from "./topology.js";
import { parseSetDeleteMode, parsePortList } from "./utils.js";
import { resolveCredentials, listSwitches, getDefaultSwitchName } from "./config.js";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "tplink-easy-smart-switch-mcp",
  version: "0.4.9",
});

const connectionInput = {
  host: z.string().optional().describe("Switch address or configured name. Defaults to the default switch in ~/.config/tplink-mcp/switches.json, then TPLINK_HOST, then 192.168.3.10."),
  username: z.string().optional().describe("Login username. Defaults to the configured switch username or TPLINK_USERNAME."),
  password: z.string().optional().describe("Login password. Defaults to the configured switch password or TPLINK_PASSWORD."),
  debug: z.boolean().optional().describe("Return page parsing details. Defaults to false."),
};

const writeInputBase = {
  host: z.string().optional().describe("Switch address or configured name."),
  username: z.string().optional().describe("Login username."),
  password: z.string().optional().describe("Login password."),
  apply: z.boolean().optional().describe("Defaults to false. false returns a dry-run preview; true submits the request."),
  confirm: z.string().optional().describe('Real writes require confirm: "APPLY".'),
};

function resolveInput<T extends { host?: string; username?: string; password?: string }>(input: T): T {
  const resolved = resolveCredentials(input.host, input.username, input.password);
  return { ...input, ...resolved };
}

type TopologyFacts = Awaited<ReturnType<SwitchClient["collectTopologyFacts"]>>;
type MacSearchResult = Awaited<ReturnType<SwitchClient["searchMacAddressInSession"]>>["mac_search"];

async function addPeerMacSearchEvidence(contexts: Array<{ client: SwitchClient; facts: TopologyFacts }>) {
  const tasks: Array<Promise<void>> = [];

  for (const context of contexts) {
    for (const peer of contexts) {
      if (context === peer || !peer.facts.identity.mac) continue;
      tasks.push(
        context.client.searchMacAddressInSession(peer.facts.identity.mac)
          .then((result) => mergeMacSearchEvidence(context.facts, result.mac_search))
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            context.facts.mac_table = {
              ...context.facts.mac_table,
              note: [context.facts.mac_table.note, `MAC search failed: ${message}`].filter(Boolean).join(" "),
            };
          }),
      );
    }
  }

  await Promise.all(tasks);
}

function mergeMacSearchEvidence(facts: TopologyFacts, macSearch: MacSearchResult): void {
  if (!macSearch.readable) return;

  const entries = [...facts.mac_table.entries];
  const seen = new Set(entries.map((entry) => `${entry.mac}|${entry.vlan ?? ""}|${entry.port ?? ""}`));
  for (const entry of macSearch.entries) {
    const key = `${entry.mac}|${entry.vlan ?? ""}|${entry.port ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }

  facts.mac_table = {
    ...facts.mac_table,
    readable: true,
    count: entries.length,
    entries,
    source: facts.mac_table.source === "none" ? "mac_search" : facts.mac_table.source,
    note: [facts.mac_table.note, macSearch.note].filter(Boolean).join(" "),
  };
}

server.registerTool(
  "list_switches",
  {
    title: "List Configured Switches",
    description: "Return all switches saved in the local switch configuration file (~/.config/tplink-mcp/switches.json). Run the TUI (bun run tui) to add or remove switches.",
    inputSchema: {},
  },
  async () => {
    const switches = listSwitches();
    const defaultName = getDefaultSwitchName();
    return jsonResult({ switches, default: defaultName, config_hint: "Run: bun run tui" });
  },
);

server.registerTool(
  "get_switch_status",
  {
    title: "Get Switch Status",
    description: "Read a TP-Link or Mercury Easy Smart switch Web UI and return a device status summary.",
    inputSchema: connectionInput,
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.getSwitchStatus(r.username, r.password, r.debug ?? false));
  },
);

server.registerTool(
  "get_port_status",
  {
    title: "Get Port Status",
    description: "Read a TP-Link or Mercury Easy Smart switch Web UI and return port status.",
    inputSchema: connectionInput,
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.getPortStatus(r.username, r.password, r.debug ?? false));
  },
);

server.registerTool(
  "get_vlan_status",
  {
    title: "Get VLAN Status",
    description: "Read port VLAN, 802.1Q VLAN, PVID, and MTU VLAN status without submitting any configuration.",
    inputSchema: connectionInput,
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.getVlanStatus(r.username, r.password, r.debug ?? false));
  },
);

server.registerTool(
  "get_trunk_status",
  {
    title: "Get Trunk Status",
    description: "Read port trunking/LAG status without submitting any configuration.",
    inputSchema: connectionInput,
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.getTrunkStatus(r.username, r.password, r.debug ?? false));
  },
);

server.registerTool(
  "search_mac_address",
  {
    title: "Search MAC Address",
    description: "Run the switch Web UI's read-only MAC address search CGI and return the learned port/VLAN for one MAC address when the switch has an entry.",
    inputSchema: {
      ...connectionInput,
      mac: z.string().describe("MAC address to search, for example 00:11:22:33:44:55."),
      vlan: z.number().int().min(0).max(4094).optional().describe("Optional VLAN ID. Defaults to 0, which matches the Web UI's all/default search behavior on tested firmware."),
    },
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.searchMacAddress({
      username: r.username,
      password: r.password,
      mac: r.mac,
      vlan: r.vlan,
      debug: r.debug ?? false,
    }));
  },
);

server.registerTool(
  "analyze_topology",
  {
    title: "Analyze Switch Topology",
    description:
      "Analyze the topology relationship between two (or more) cascaded switches. Logs into each switch, reads its identity, ports, 802.1Q VLAN/PVID, and MAC evidence, then finds the inter-switch link port, infers the upstream/downstream relationship, and reports the VLAN relationship across the link. Link detection queries each switch for the other's management MAC when supported; otherwise it falls back to the active SFP/10G port as a low-confidence guess.",
    inputSchema: {
      hosts: z.array(z.string()).min(2).optional().describe('The switches to analyze, by configured name or address, for example ["192.168.3.10", "192.168.3.11"]. Defaults to the two switches in the local config when omitted.'),
      username: z.string().optional().describe("Shared login username, used when a switch has no per-switch credentials in the config."),
      password: z.string().optional().describe("Shared login password, used when a switch has no per-switch credentials in the config."),
    },
  },
  async (input) => {
    const hosts = input.hosts && input.hosts.length >= 2
      ? input.hosts
      : listSwitches().map((s) => s.name);
    if (hosts.length < 2) {
      return jsonResult({
        error: "analyze_topology needs at least two switches. Pass hosts: [\"a\", \"b\"] or configure two switches with the TUI (bun run tui).",
      });
    }

    const contexts = await Promise.all(
      hosts.map(async (host) => {
        const r = resolveCredentials(host, input.username, input.password);
        const client = new SwitchClient(r.host);
        const facts = await client.collectTopologyFacts(r.username, r.password);
        return { client, facts };
      }),
    );
    await addPeerMacSearchEvidence(contexts);

    return jsonResult(analyzeTopology(contexts.map((context) => context.facts)));
  },
);

server.registerTool(
  "configure_mtu_vlan",
  {
    title: "Configure MTU VLAN",
    description: "Generate or submit MTU VLAN CGI requests from VlanMtuRpm.htm. Defaults to dry-run.",
    inputSchema: {
      ...writeInputBase,
      enabled: z.boolean().optional().describe("Enable or disable MTU VLAN. Omit to leave the current state unchanged."),
      uplinkPort: z.number().int().min(1).optional().describe("Set the MTU VLAN uplink port. Omit to leave it unchanged."),
    },
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.configureMtuVlan({
      username: r.username,
      password: r.password,
      enabled: r.enabled,
      uplinkPort: r.uplinkPort,
      apply: r.apply ?? false,
      confirm: r.confirm,
    }));
  },
);

server.registerTool(
  "configure_port_vlan",
  {
    title: "Configure Port VLAN",
    description: "Generate or submit port VLAN CGI requests from VlanPortBasicRpm.htm. Defaults to dry-run.",
    inputSchema: {
      ...writeInputBase,
      enabled: z.boolean().optional().describe("Enable or disable port VLAN. Omit to leave the current state unchanged."),
      mode: z.string().optional().describe("set adds or updates a port VLAN; delete removes one. Defaults to set."),
      vid: z.number().int().min(1).optional().describe("Port VLAN ID."),
      ports: z.string().optional().describe('Member ports, comma-separated, for example "1,2".'),
    },
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.configurePortVlan({
      username: r.username,
      password: r.password,
      enabled: r.enabled,
      mode: parseSetDeleteMode(r.mode),
      vid: r.vid,
      ports: parsePortList(r.ports),
      apply: r.apply ?? false,
      confirm: r.confirm,
    }));
  },
);

server.registerTool(
  "configure_8021q_vlan",
  {
    title: "Configure 802.1Q VLAN",
    description: "Generate or submit 802.1Q VLAN CGI requests from Vlan8021QRpm.htm. Defaults to dry-run.",
    inputSchema: {
      ...writeInputBase,
      enabled: z.boolean().optional().describe("Enable or disable 802.1Q VLAN. Omit to leave the current state unchanged."),
      mode: z.string().optional().describe("set adds or updates a VLAN; delete removes one. Defaults to set."),
      vid: z.number().int().min(1).optional().describe("VLAN ID, range 1-4094."),
      name: z.string().optional().describe("VLAN description. The Web UI limits this to 12 characters."),
      untaggedPorts: z.string().optional().describe('Untagged ports, comma-separated, for example "1,2".'),
      taggedPorts: z.string().optional().describe('Tagged ports, comma-separated, for example "5,6".'),
    },
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.configure8021qVlan({
      username: r.username,
      password: r.password,
      enabled: r.enabled,
      mode: parseSetDeleteMode(r.mode),
      vid: r.vid,
      name: r.name,
      untaggedPorts: parsePortList(r.untaggedPorts),
      taggedPorts: parsePortList(r.taggedPorts),
      apply: r.apply ?? false,
      confirm: r.confirm,
    }));
  },
);

server.registerTool(
  "configure_vlan_pvid",
  {
    title: "Configure 802.1Q PVID",
    description: "Generate or submit PVID CGI requests from Vlan8021QPvidRpm.htm. Defaults to dry-run.",
    inputSchema: {
      ...writeInputBase,
      pvid: z.number().int().min(1).describe("PVID, range 1-4094."),
      ports: z.string().describe('Target ports, comma-separated, for example "1,2".'),
    },
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.configureVlanPvid({
      username: r.username,
      password: r.password,
      pvid: r.pvid,
      ports: parsePortList(r.ports),
      apply: r.apply ?? false,
      confirm: r.confirm,
    }));
  },
);

server.registerTool(
  "configure_trunk_group",
  {
    title: "Configure Port Trunk",
    description: "Generate or submit port trunking CGI requests from PortTrunkRpm.htm. Defaults to dry-run.",
    inputSchema: {
      ...writeInputBase,
      group: z.number().int().min(1).describe("Trunk group number."),
      ports: z.string().optional().describe('Member ports, comma-separated, for example "1,2". mode=set requires at least 2 ports; mode=delete ignores this field.'),
      mode: z.string().optional().describe("set creates or updates a trunk group; delete removes one. Defaults to set."),
    },
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.configureTrunkGroup({
      username: r.username,
      password: r.password,
      group: r.group,
      ports: parsePortList(r.ports),
      mode: parseSetDeleteMode(r.mode),
      apply: r.apply ?? false,
      confirm: r.confirm,
    }));
  },
);

server.registerTool(
  "save_configuration",
  {
    title: "Save Configuration",
    description: "Generate or submit the save-configuration CGI request from SavingConfigRpm.htm. Defaults to dry-run.",
    inputSchema: writeInputBase,
  },
  async (input) => {
    const r = resolveInput(input);
    const client = new SwitchClient(r.host);
    return jsonResult(await client.saveConfiguration({
      username: r.username,
      password: r.password,
      apply: r.apply ?? false,
      confirm: r.confirm,
    }));
  },
);

// This is an MCP stdio server: it speaks JSON-RPC over stdin/stdout and prints
// nothing human-readable on success. When a person launches it directly in a
// terminal (stdin is a TTY rather than a pipe from an MCP client), it would
// otherwise appear to hang with no output. Print guidance to stderr so the run
// is not silent. stderr is safe to write to because the JSON-RPC channel is stdout.
if (process.stdin.isTTY) {
  console.error(
    [
      "tplink-easy-smart-switch-mcp is a Model Context Protocol (MCP) server.",
      "It communicates over stdin/stdout using JSON-RPC and is meant to be launched",
      "by an MCP client (see the MCP Client Example in README.md), not run by hand.",
      "",
      "It is now waiting for JSON-RPC on stdin and will look idle. Press Ctrl+C to exit.",
      "",
      "If you wanted to:",
      "  - manage switches (add/remove/test):   bun run tui",
      "  - call a tool from the command line:    bun run debug -- --tool get_switch_status",
      "  - list available tools:                 bun run debug",
      "",
    ].join("\n"),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
