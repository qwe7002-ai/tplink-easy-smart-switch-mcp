import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parse } from "node-html-parser";
import { z } from "zod";
import net from "node:net";

const DEFAULT_HOST = "192.168.3.10";
const DEFAULT_TIMEOUT_MS = 5000;
const VENDOR_LOGIN_LABEL = "\u767b\u5f55";
const VENDOR_APPLY_LABEL = "\u5e94\u7528";
const VENDOR_DELETE_LABEL = "\u5220\u9664";
const VENDOR_ADD_EDIT_LABEL = "\u6dfb\u52a0/\u7f16\u8f91";
const VENDOR_SAVE_TEXT = "\u4fdd\u5b58";
const VENDOR_CONFIG_TEXT = "\u914d\u7f6e";
const VENDOR_RISKY_TEXT_PATTERN = "\u5907\u4efd|\u6062\u590d|\u590d\u4f4d|\u91cd\u542f|\u5347\u7ea7|\u5bfc\u5165";
const VENDOR_COPYRIGHT_TEXT_PATTERN = "\u666e\u8054\u6280\u672f\u6709\u9650\u516c\u53f8 \u7248\u6743\u6240\u6709";
const PASSWORD_SALT = "RDpbLfCPsJZ7fiv";
const PASSWORD_TABLE =
  "yLwVl0zKqws7LgKPRQ84Mdt708T1qQ3Ha7xv3H7NyU84p21BriUWBU43odz3iP4rBL3cD02KZciXTysVXiV8ngg6vL48rPJyAUw0HurW20xqxv9aYb4M9wK1Ae0wlro510qXeU07kV57fQMc8L6aLgMLwygtc0F10a0Dg70TOoouyFhdysuRMO51yY5ZlOZZLEal1h0t9YQW0Ko7oBwmCAHoic4HYbUyVeU3sfQ1xtXcPcf1aT303wAQhv66qzW";

interface Session {
  cookies: Map<string, string>;
}

interface HttpResult {
  status: number;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  raw_head: string;
}

interface FormattedPage {
  title: string | null;
  text: string;
  forms: Array<Record<string, unknown>>;
  frames: Array<Record<string, string | null>>;
  links: Array<Record<string, string | null>>;
  scripts: Array<Record<string, string | null>>;
  tables: string[][];
}

interface CgiRequestPlan {
  description: string;
  action: string;
  method: "GET" | "POST";
  referer: string;
  params: Array<[string, string]>;
  will_submit: boolean;
}

interface SaveConfigDiscovery {
  action: string;
  method: "GET" | "POST";
  params: Array<[string, string]>;
  source: "form" | "script" | "fallback";
  confidence: "high" | "medium" | "fallback";
  note?: string;
}

const sessions = new Map<string, Session>();

const server = new McpServer({
  name: "tplink-easy-smart-switch-mcp",
  version: "0.4.7",
});

const connectionInput = {
  host: z.string().optional().describe("Switch address. Defaults to 192.168.3.10."),
  username: z.string().optional().describe("Login username. Defaults to TPLINK_USERNAME."),
  password: z.string().optional().describe("Login password. Defaults to TPLINK_PASSWORD."),
  debug: z.boolean().optional().describe("Return page parsing details. Defaults to false."),
};

const writeInputBase = {
  host: z.string().optional().describe("Switch address. Defaults to 192.168.3.10."),
  username: z.string().optional().describe("Login username. Defaults to TPLINK_USERNAME."),
  password: z.string().optional().describe("Login password. Defaults to TPLINK_PASSWORD."),
  apply: z.boolean().optional().describe("Defaults to false. false returns a dry-run preview; true submits the request."),
  confirm: z.string().optional().describe('Real writes require confirm: "APPLY".'),
};

server.registerTool(
  "get_switch_status",
  {
    title: "Get Switch Status",
    description: "Read a TP-Link or Mercury Easy Smart switch Web UI and return a device status summary.",
    inputSchema: connectionInput,
  },
  async (input) => {
    const client = new SwitchClient(input.host);
    const status = await client.getSwitchStatus(input.username, input.password, input.debug ?? false);
    return jsonResult(status);
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
    const client = new SwitchClient(input.host);
    const status = await client.getPortStatus(input.username, input.password, input.debug ?? false);
    return jsonResult(status);
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
    const client = new SwitchClient(input.host);
    const status = await client.getVlanStatus(input.username, input.password, input.debug ?? false);
    return jsonResult(status);
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
    const client = new SwitchClient(input.host);
    const status = await client.getTrunkStatus(input.username, input.password, input.debug ?? false);
    return jsonResult(status);
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
    const client = new SwitchClient(input.host);
    const result = await client.configureMtuVlan({
      username: input.username,
      password: input.password,
      enabled: input.enabled,
      uplinkPort: input.uplinkPort,
      apply: input.apply ?? false,
      confirm: input.confirm,
    });
    return jsonResult(result);
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
    const client = new SwitchClient(input.host);
    const result = await client.configurePortVlan({
      username: input.username,
      password: input.password,
      enabled: input.enabled,
      mode: parseVlanEditMode(input.mode),
      vid: input.vid,
      ports: parsePortList(input.ports),
      apply: input.apply ?? false,
      confirm: input.confirm,
    });
    return jsonResult(result);
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
    const client = new SwitchClient(input.host);
    const result = await client.configure8021qVlan({
      username: input.username,
      password: input.password,
      enabled: input.enabled,
      mode: parseVlanEditMode(input.mode),
      vid: input.vid,
      name: input.name,
      untaggedPorts: parsePortList(input.untaggedPorts),
      taggedPorts: parsePortList(input.taggedPorts),
      apply: input.apply ?? false,
      confirm: input.confirm,
    });
    return jsonResult(result);
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
    const client = new SwitchClient(input.host);
    const result = await client.configureVlanPvid({
      username: input.username,
      password: input.password,
      pvid: input.pvid,
      ports: parsePortList(input.ports),
      apply: input.apply ?? false,
      confirm: input.confirm,
    });
    return jsonResult(result);
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
    const client = new SwitchClient(input.host);
    const result = await client.configureTrunkGroup({
      username: input.username,
      password: input.password,
      group: input.group,
      ports: parsePortList(input.ports),
      mode: parseTrunkMode(input.mode),
      apply: input.apply ?? false,
      confirm: input.confirm,
    });
    return jsonResult(result);
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
    const client = new SwitchClient(input.host);
    const result = await client.saveConfiguration({
      username: input.username,
      password: input.password,
      apply: input.apply ?? false,
      confirm: input.confirm,
    });
    return jsonResult(result);
  },
);

class SwitchClient {
  readonly target: URL;

  constructor(host?: string) {
    this.target = normalizeTarget(host);
  }

  async getSwitchStatus(username?: string, password?: string, debug = false) {
    const httpOpen = await tcpOpen(this.target.hostname, 80);
    if (!httpOpen) {
      return {
        target: this.target.origin,
        reachable: false,
        error: "HTTP 80 is not reachable",
      };
    }

    const loginPage = await this.fetchText("/");
    const statusPaths = [
      "/MainRpm.htm",
      "/MainRpm.js",
      "/Top.htm",
      "/Product.htm",
      "/Menu.htm",
      "/tab.htm",
      "/StatusRpm.htm",
      "/userRpm/StatusRpm.htm",
      "/userRpm/SysStatusRpm.htm",
      "/userRpm/SystemInfoRpm.htm",
      "/frame.htm",
      "/mainFrame.htm",
    ];
    let page = await this.firstReadablePage(statusPaths);
    let login: Record<string, unknown> = {
      attempted: false,
      message: "The status page is directly readable, so login was not submitted.",
    };

    if (!isRecord(page.data)) {
      login = await this.loginIfPossible(username, password);
      const discoveredPaths = "paths" in login && Array.isArray(login.paths) ? login.paths : [];
      page = await this.firstReadablePage(uniquePaths([
        ...statusPaths,
        ...filterStatusCandidatePaths(discoveredPaths),
        "/",
      ]));
    }

    return buildStatusResponse({
      target: this.target.origin,
      reachable: true,
      product: extractNumberVar(loginPage.body, "g_product"),
      year: extractNumberVar(loginPage.body, "g_year"),
      encrypt_type: extractNumberVar(loginPage.body, "encryptType"),
      login,
      page,
      debug,
    });
  }

  async getPortStatus(username?: string, password?: string, debug = false) {
    const portPaths = [
      "/MainRpm.htm",
      "/MainRpm.js",
      "/userRpm/PortStatusRpm.htm",
      "/userRpm/PortConfigRpm.htm",
      "/PortStatusRpm.htm",
      "/PortConfigRpm.htm",
      "/mainFrame.htm",
    ];
    let page = await this.firstReadablePage(portPaths);
    let login: Record<string, unknown> = {
      attempted: false,
      message: "The port status page is directly readable, so login was not submitted.",
    };

    if (!isRecord(page.data)) {
      login = await this.loginIfPossible(username, password);
      const discoveredPaths = "paths" in login && Array.isArray(login.paths) ? login.paths : [];
      page = await this.firstReadablePage(uniquePaths([
        ...portPaths,
        ...filterStatusCandidatePaths(discoveredPaths).filter((path) => /mainrpm|port|status|state|link|frame/i.test(path)),
      ]));
    }

    const response = buildStatusResponse({
      target: this.target.origin,
      reachable: true,
      product: null,
      year: null,
      encrypt_type: null,
      login,
      page,
      debug,
    });

    return {
      target: response.target,
      reachable: response.reachable,
      login: response.login,
      ports: response.ports,
      source: response.source,
      ...(debug ? { debug: response.debug } : {}),
    };
  }

  async getVlanStatus(username?: string, password?: string, debug = false) {
    const login = await this.loginIfPossible(username, password);
    const main = await this.fetchText("/MainRpm.htm");
    const portVlan = await this.fetchText("/VlanPortBasicRpm.htm");
    const qvlan = await this.fetchText("/Vlan8021QRpm.htm");
    const pvid = await this.fetchText("/Vlan8021QPvidRpm.htm");
    const mtu = await this.fetchText("/VlanMtuRpm.htm");
    const mainData = parseMainRpmPage(main.body);
    const portVlanData = parsePortVlanPage(portVlan.body);
    const qvlanData = parseQvlanPage(qvlan.body);
    const pvidData = parsePvidPage(pvid.body);
    const mtuData = parseVlanMtuPage(mtu.body);
    const portVlanPage = formatHtmlPage(portVlan.body);
    const qvlanPage = formatHtmlPage(qvlan.body);
    const pvidPage = formatHtmlPage(pvid.body);
    const mtuPage = formatHtmlPage(mtu.body);

    return {
      target: this.target.origin,
      reachable: true,
      login: summarizeLogin(login),
      vlan_summary: mainData?.vlan ?? null,
      port_vlan: portVlanData,
      vlan_8021q: qvlanData,
      pvid: pvidData,
      mtu_vlan: mtuData,
      write_endpoints: {
        port_vlan: describeWriteEndpoints(portVlanPage),
        vlan_8021q: describeWriteEndpoints(qvlanPage),
        pvid: [
          ...describeWriteEndpoints(pvidPage),
          {
            action: "vlanPvidSet.cgi",
            method: "GET",
            disabled: true,
            reason: "Read-only discovery mode; the JS location.href configuration request is not submitted.",
            inputs: ["pbm", "pvid", "token"],
          },
        ],
        mtu_vlan: describeWriteEndpoints(mtuPage),
      },
      sources: {
        vlan_summary: { path: "/MainRpm.htm", status: main.status },
        port_vlan: { path: "/VlanPortBasicRpm.htm", status: portVlan.status },
        vlan_8021q: { path: "/Vlan8021QRpm.htm", status: qvlan.status },
        pvid: { path: "/Vlan8021QPvidRpm.htm", status: pvid.status },
        mtu_vlan: { path: "/VlanMtuRpm.htm", status: mtu.status },
      },
      ...(debug ? {
        debug: {
          main_page: formatHtmlPage(main.body),
          port_vlan_page: portVlanPage,
          qvlan_page: qvlanPage,
          pvid_page: pvidPage,
          mtu_page: mtuPage,
        },
      } : {}),
    };
  }

  async getTrunkStatus(username?: string, password?: string, debug = false) {
    const login = await this.loginIfPossible(username, password);
    const page = await this.fetchText("/PortTrunkRpm.htm");
    const trunk = parsePortTrunkPage(page.body);
    const formatted = formatHtmlPage(page.body);

    return {
      target: this.target.origin,
      reachable: true,
      login: summarizeLogin(login),
      trunk,
      write_endpoints: describeWriteEndpoints(formatted),
      source: {
        path: "/PortTrunkRpm.htm",
        status: page.status,
      },
      ...(debug ? {
        debug: {
          page: formatted,
        },
      } : {}),
    };
  }

  async configureMtuVlan(input: {
    username?: string;
    password?: string;
    enabled?: boolean;
    uplinkPort?: number;
    apply: boolean;
    confirm?: string;
  }) {
    const login = await this.loginIfPossible(input.username, input.password);
    const page = await this.fetchText("/VlanMtuRpm.htm");
    const mtu = parseVlanMtuPage(page.body);
    const token = await this.readToken();
    const plans = buildMtuVlanPlans(input, mtu, token);
    const validation = validateMtuVlanPlans(input, mtu, plans);

    if (!input.apply) {
      return dryRunResult(this.target.origin, "mtu_vlan", login, validation, plans, {
        path: "/VlanMtuRpm.htm",
        status: page.status,
      });
    }

    ensureWriteAllowed(input.confirm, validation, token, login);
    const responses = [];
    for (const plan of plans) {
      responses.push(await this.submitPlan(plan));
    }

    return applyResult(this.target.origin, "mtu_vlan", login, validation, plans, responses);
  }

  async configurePortVlan(input: {
    username?: string;
    password?: string;
    enabled?: boolean;
    mode: "set" | "delete";
    vid?: number;
    ports: number[];
    apply: boolean;
    confirm?: string;
  }) {
    const login = await this.loginIfPossible(input.username, input.password);
    const page = await this.fetchText("/VlanPortBasicRpm.htm");
    const portVlan = parsePortVlanPage(page.body);
    const token = await this.readToken();
    const plans = buildPortVlanPlans(input, portVlan, token);
    const validation = validatePortVlanPlans(input, portVlan, plans);

    if (!input.apply) {
      return dryRunResult(this.target.origin, "port_vlan", login, validation, plans, {
        path: "/VlanPortBasicRpm.htm",
        status: page.status,
      });
    }

    ensureWriteAllowed(input.confirm, validation, token, login);
    const responses = [];
    for (const plan of plans) {
      responses.push(await this.submitPlan(plan));
    }

    return applyResult(this.target.origin, "port_vlan", login, validation, plans, responses);
  }

  async configure8021qVlan(input: {
    username?: string;
    password?: string;
    enabled?: boolean;
    mode: "set" | "delete";
    vid?: number;
    name?: string;
    untaggedPorts: number[];
    taggedPorts: number[];
    apply: boolean;
    confirm?: string;
  }) {
    const login = await this.loginIfPossible(input.username, input.password);
    const page = await this.fetchText("/Vlan8021QRpm.htm");
    const qvlan = parseQvlanPage(page.body);
    const token = await this.readToken();
    const plans = build8021qVlanPlans(input, qvlan, token);
    const validation = validate8021qVlanPlans(input, qvlan, plans);

    if (!input.apply) {
      return dryRunResult(this.target.origin, "vlan_8021q", login, validation, plans, {
        path: "/Vlan8021QRpm.htm",
        status: page.status,
      });
    }

    ensureWriteAllowed(input.confirm, validation, token, login);
    const responses = [];
    for (const plan of plans) {
      responses.push(await this.submitPlan(plan));
    }

    return applyResult(this.target.origin, "vlan_8021q", login, validation, plans, responses);
  }

  async configureVlanPvid(input: {
    username?: string;
    password?: string;
    pvid: number;
    ports: number[];
    apply: boolean;
    confirm?: string;
  }) {
    const login = await this.loginIfPossible(input.username, input.password);
    const page = await this.fetchText("/Vlan8021QPvidRpm.htm");
    const pvid = parsePvidPage(page.body);
    const token = await this.readToken();
    const plans = buildPvidPlans(input, pvid, token);
    const validation = validatePvidPlans(input, pvid, plans);

    if (!input.apply) {
      return dryRunResult(this.target.origin, "vlan_pvid", login, validation, plans, {
        path: "/Vlan8021QPvidRpm.htm",
        status: page.status,
      });
    }

    ensureWriteAllowed(input.confirm, validation, token, login);
    const responses = [];
    for (const plan of plans) {
      responses.push(await this.submitPlan(plan));
    }

    return applyResult(this.target.origin, "vlan_pvid", login, validation, plans, responses);
  }

  async configureTrunkGroup(input: {
    username?: string;
    password?: string;
    group: number;
    ports: number[];
    mode: "set" | "delete";
    apply: boolean;
    confirm?: string;
  }) {
    const login = await this.loginIfPossible(input.username, input.password);
    const page = await this.fetchText("/PortTrunkRpm.htm");
    const trunk = parsePortTrunkPage(page.body);
    const token = await this.readToken();
    const plans = buildTrunkPlans(input, trunk, token);
    const validation = validateTrunkPlans(input, trunk);

    if (!input.apply) {
      return dryRunResult(this.target.origin, "trunk_group", login, validation, plans, {
        path: "/PortTrunkRpm.htm",
        status: page.status,
      });
    }

    ensureWriteAllowed(input.confirm, validation, token, login);
    const responses = [];
    for (const plan of plans) {
      responses.push(await this.submitPlan(plan));
    }

    return applyResult(this.target.origin, "trunk_group", login, validation, plans, responses);
  }

  async saveConfiguration(input: {
    username?: string;
    password?: string;
    apply: boolean;
    confirm?: string;
  }) {
    const login = await this.loginIfPossible(input.username, input.password);
    let page: { status: number | null; body: string; error?: string };

    try {
      const response = await this.fetchText("/SavingConfigRpm.htm");
      page = { status: response.status, body: response.body };
    } catch (error) {
      page = {
        status: null,
        body: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const token = await this.readToken();
    const discovery = discoverSaveConfigEndpoint(page.body);
    const plans = buildSaveConfigurationPlans(discovery, token);
    const validation = validateSaveConfigurationPlans(discovery, page.error, plans);

    if (!input.apply) {
      return dryRunResult(this.target.origin, "save_configuration", login, validation, plans, {
        path: "/SavingConfigRpm.htm",
        status: page.status,
        error: page.error,
      });
    }

    ensureWriteAllowed(input.confirm, validation, token, login);
    const responses = [];
    for (const plan of plans) {
      responses.push(await this.submitPlan(plan));
    }

    return applyResult(this.target.origin, "save_configuration", login, validation, plans, responses);
  }

  private async loginIfPossible(username?: string, password?: string) {
    const user = username ?? process.env.TPLINK_USERNAME;
    const pass = password ?? process.env.TPLINK_PASSWORD;

    if (!user || !pass) {
      return {
        attempted: false,
        message: "No username or password was provided. Only information visible without login is returned. You can set TPLINK_USERNAME/TPLINK_PASSWORD.",
      };
    }

    const loginPageResponse = await this.fetch("/", { method: "GET" });
    rememberCookies(this.target, loginPageResponse);

    const body = new URLSearchParams({
      username: user,
      password: encodeTplinkPassword(pass),
      logon: VENDOR_LOGIN_LABEL,
    });

    const response = await this.fetch("/logon.cgi", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "max-age=0",
        Referer: `${this.target.origin}/`,
      },
    });
    rememberCookies(this.target, response);
    const text = response.body;
    const loginPage = looksLikeLoginPage(text);
    const errorCode = extractLogonErrorCode(text);
    const cookiesSaved = cookieHeader(this.target) !== "";
    const formatted = formatHtmlPage(text);
    const paths = extractCandidatePaths(formatted);

    return {
      attempted: true,
      status: response.status,
      success_hint: cookiesSaved && (errorCode === null || errorCode === 0),
      final_url: response.url,
      cookies_saved: cookiesSaved,
      error_code: errorCode,
      response_page: {
        title: formatted.title,
        text: formatted.text.slice(0, 1200),
        frames: formatted.frames,
        links: formatted.links,
        scripts: formatted.scripts,
        forms: formatted.forms,
        tables: formatted.tables,
      },
      paths,
    };
  }

  private async readToken(): Promise<string | null> {
    const candidates = ["/", "/Menu.htm", "/MainRpm.htm"];
    for (const path of candidates) {
      try {
        const response = await this.fetchText(path);
        const token = extractToken(response.body);
        if (token) {
          return token;
        }
      } catch {
        // Keep trying read-only pages; some firmware closes protected pages.
      }
    }
    return null;
  }

  private async submitPlan(plan: CgiRequestPlan): Promise<Record<string, unknown>> {
    const params = new URLSearchParams(plan.params);
    const path = plan.method === "GET" ? `${plan.action}?${params.toString()}` : plan.action;
    const response = await this.fetch(path, {
      method: plan.method,
      body: plan.method === "POST" ? params : undefined,
      headers: {
        ...(plan.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        Referer: `${this.target.origin}/${plan.referer}`,
      },
    });
    return {
      action: plan.action,
      status: response.status,
      body_preview: htmlToText(response.body).slice(0, 400),
    };
  }

  private async firstReadablePage(paths: string[]) {
    const tried = [];

    for (const path of paths) {
      try {
        const page = await this.fetchText(path);
        const formatted = formatHtmlPage(page.body);
        const meaningful = isMeaningfulPage(page.body, formatted);
        tried.push({
          path,
          status: page.status,
          length: page.body.length,
          meaningful,
          title: formatted.title,
          frames: formatted.frames,
          forms: formatted.forms.length,
          links: formatted.links.length,
          scripts: formatted.scripts.length,
          tables: formatted.tables.length,
          text: formatted.text.slice(0, 240),
        });
        if (page.status >= 200 && page.status < 400 && meaningful) {
          return {
            path,
            status: page.status,
            data: parseMainRpmPage(page.body),
            title: formatted.title,
            text: formatted.text.slice(0, 4000),
            forms: formatted.forms,
            frames: formatted.frames,
            links: formatted.links,
            tables: formatted.tables,
            tried,
          };
        }
      } catch (error) {
        tried.push({
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      path: null,
      status: null,
      title: null,
      text: "",
      tried,
    };
  }

  private async fetchText(path: string) {
    const response = await this.fetch(path, { method: "GET" });
    rememberCookies(this.target, response);
    return {
      status: response.status,
      body: response.body,
    };
  }

  private async fetch(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: BodyInit | null;
      headers?: Record<string, string>;
    },
  ): Promise<HttpResult> {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.target.origin);
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const cookies = cookieHeader(this.target);

    if (cookies) {
      headers.Cookie = cookies;
    }

    return httpRequest(url, {
      method: options.method,
      headers,
      body: options.body,
    });
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);

function normalizeTarget(host?: string): URL {
  const raw = host?.trim() || process.env.TPLINK_HOST || DEFAULT_HOST;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return new URL(withScheme);
}

function encodeTplinkPassword(password: string): string {
  let encoded = "";
  const maxLen = Math.max(password.length, PASSWORD_SALT.length);

  for (let i = 0; i < maxLen; i += 1) {
    let left = 187;
    let right = 187;

    if (i >= password.length) {
      right = PASSWORD_SALT.charCodeAt(i);
    } else if (i >= PASSWORD_SALT.length) {
      left = password.charCodeAt(i);
    } else {
      left = password.charCodeAt(i);
      right = PASSWORD_SALT.charCodeAt(i);
    }

    encoded += PASSWORD_TABLE.charAt((left ^ right) % PASSWORD_TABLE.length);
  }

  return encoded;
}

function rememberCookies(target: URL, response: HttpResult): void {
  const setCookie = response.headers["set-cookie"];
  if (!setCookie) {
    return;
  }

  const session = getSession(target);
  const cookies = Array.isArray(setCookie) ? setCookie : splitSetCookie(setCookie);
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) {
      session.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
}

function cookieHeader(target: URL): string {
  const session = sessions.get(target.origin);
  if (!session) {
    return "";
  }
  return [...session.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function getSession(target: URL): Session {
  let session = sessions.get(target.origin);
  if (!session) {
    session = { cookies: new Map() };
    sessions.set(target.origin, session);
  }
  return session;
}

function splitSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function httpRequest(
  url: URL,
  options: {
    method: "GET" | "POST";
    body?: BodyInit | null;
    headers?: Record<string, string>;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = bodyToString(options.body);
    const headers: Record<string, string | number> = {
      "User-Agent": "Mozilla/5.0 tplink-easy-smart-switch-mcp",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9,zh-HK;q=0.8,zh;q=0.7,en-US;q=0.6,zh-TW;q=0.5,zh-CN;q=0.4",
      Connection: "close",
      "Upgrade-Insecure-Requests": "1",
      ...(options.headers ?? {}),
    };

    if (body !== undefined && headers["Content-Length"] === undefined) {
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const port = Number(url.port || 80);
    const socket = net.createConnection({ host: url.hostname, port });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;

      const raw = Buffer.concat(chunks);
      if (raw.length === 0) {
        reject(new Error("HTTP connection closed without response data"));
        return;
      }

      resolve(parseRawHttpResponse(url, raw));
    };

    socket.setTimeout(timeoutMs(), () => {
      socket.destroy(new Error(`HTTP timeout after ${timeoutMs()}ms`));
    });

    socket.on("connect", () => {
      const head = [
        `${options.method} ${url.pathname}${url.search || ""} HTTP/1.0`,
        `Host: ${url.host}`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        "",
        "",
      ].join("\r\n");

      socket.write(head);
      if (body !== undefined) {
        socket.write(body);
      }
    });

    socket.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    socket.on("close", finish);
    socket.on("end", finish);
    socket.on("error", (error) => {
      if (chunks.length > 0) {
        finish();
        return;
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function parseRawHttpResponse(url: URL, raw: Buffer): HttpResult {
  const marker = raw.indexOf("\r\n\r\n");
  const splitAt = marker === -1 ? raw.indexOf("\n\n") : marker;
  const separatorLength = marker === -1 ? 2 : 4;
  const head = splitAt === -1 ? "" : raw.slice(0, splitAt).toString("latin1");
  const bodyBuffer = splitAt === -1 ? raw : raw.slice(splitAt + separatorLength);
  const lines = head.split(/\r?\n/).filter(Boolean);
  const status = Number(lines[0]?.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? 0);
  const headers: Record<string, string | string[] | undefined> = {};

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const existing = headers[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing !== undefined) {
      headers[key] = [existing, value];
    } else {
      headers[key] = value;
    }
  }

  return {
    status,
    url: url.toString(),
    headers,
    body: decodeBody(bodyBuffer, headers),
    raw_head: head,
  };
}

function decodeBody(body: Buffer, headers: Record<string, string | string[] | undefined>): string {
  const transferEncoding = headerValue(headers, "transfer-encoding").toLowerCase();
  const payload = transferEncoding.includes("chunked") ? decodeChunkedBody(body) : body;
  return payload.toString("utf8");
}

function decodeChunkedBody(body: Buffer): Buffer {
  const out: Buffer[] = [];
  let offset = 0;

  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      break;
    }
    const sizeText = body.slice(offset, lineEnd).toString("ascii").split(";")[0]?.trim() ?? "";
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size <= 0) {
      break;
    }
    const start = lineEnd + 2;
    const end = start + size;
    if (end > body.length) {
      out.push(body.slice(start));
      break;
    }
    out.push(body.slice(start, end));
    offset = end + 2;
  }

  return Buffer.concat(out);
}

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value ?? "";
}

function buildStatusResponse(input: {
  target: string;
  reachable: boolean;
  product: number | null;
  year: number | null;
  encrypt_type: number | null;
  login: Record<string, unknown>;
  page: Record<string, unknown>;
  debug: boolean;
}): Record<string, unknown> {
  const data = isRecord(input.page.data) ? input.page.data : {};
  const source = {
    path: input.page.path ?? null,
    status: input.page.status ?? null,
  };

  const base: Record<string, unknown> = {
    target: input.target,
    reachable: input.reachable,
    login: summarizeLogin(input.login),
    device: data.device ?? null,
    cloud: data.cloud ?? null,
    ports: data.ports ?? [],
    vlan: data.vlan ?? null,
    source,
  };

  if (input.product !== null || input.year !== null || input.encrypt_type !== null) {
    base.web_ui = {
      product: input.product,
      year: input.year,
      encrypt_type: input.encrypt_type,
    };
  }

  if (input.debug) {
    base.debug = {
      login: input.login,
      page: input.page,
    };
  }

  return base;
}

function summarizeLogin(login: Record<string, unknown>): Record<string, unknown> {
  return {
    attempted: login.attempted,
    success: login.success_hint ?? false,
    status: login.status,
    error_code: login.error_code,
    cookies_saved: login.cookies_saved,
    message: login.message,
  };
}

function parseMainRpmPage(html: string): Record<string, unknown> | null {
  const info = extractJsObject(html, "info_ds");
  const ports = extractJsObject(html, "port_info");
  const vlan = extractJsObject(html, "qvlan_ds");
  const maxPortNum = extractJsNumber(html, "max_port_num") ?? arrayLength(ports?.state);

  if (!info && !ports && !vlan) {
    return null;
  }

  return {
    device: info ? {
      model: firstString(info.hardwareStr),
      description: firstString(info.descriStr),
      mac: firstString(info.macStr),
      firmware: firstString(info.firmwareStr),
      ip: firstString(info.ipStr),
      netmask: firstString(info.netmaskStr),
      gateway: firstString(info.gatewayStr),
      dns: firstString(info.dnsStr),
      dhcp_enabled: numberToBool(info.dhcpEnable),
      dns_enabled: numberToBool(info.dnsEnable),
      uptime: firstString(info.workTime),
    } : null,
    cloud: {
      management_flag: extractJsNumber(html, "cloudMngtFlag"),
      config: extractJsNumber(html, "cloud_config"),
      status: extractJsNumber(html, "cloud_status"),
      nms_status: extractJsNumber(html, "nms_status"),
    },
    ports: ports ? buildPorts(ports, maxPortNum) : [],
    vlan: vlan ? {
      enabled: numberToBool(vlan.state),
      count: asNumber(vlan.count),
      max_vids: asNumber(vlan.maxVids),
      vlan_ids: asNumberArray(vlan.vlanList).filter((id) => id > 0).slice(0, asNumber(vlan.count) ?? undefined),
      portmask_raw: asNumberArray(vlan.portmask),
    } : null,
  };
}

function parseVlanMtuPage(html: string): Record<string, unknown> | null {
  const mtu = extractJsObject(html, "mtu_ds");
  if (!mtu) {
    return null;
  }

  return {
    enabled: numberToBool(mtu.state),
    port_count: asNumber(mtu.portNum),
    uplink_port: asNumber(mtu.uplinkPort),
  };
}

function parsePortVlanPage(html: string): Record<string, unknown> | null {
  const raw = extractJsObject(html, "pvlan_ds");
  if (!raw) {
    return null;
  }

  const portCount = asNumber(raw.portNum);
  const count = asNumber(raw.count) ?? 0;
  const vids = asNumberArray(raw.vids).slice(0, count || undefined);
  const masks = asNumberArray(raw.mbrs);

  return {
    enabled: numberToBool(raw.state),
    port_count: portCount,
    count,
    vlans: vids.map((vid, index) => {
      const mask = masks[index] ?? 0;
      return {
        vid,
        member_ports: bitmaskToPorts(mask, portCount),
        member_mask: mask,
      };
    }),
    lag_ids: asNumberArray(raw.lagIds).slice(0, portCount ?? undefined),
    lag_members_raw: asNumberArray(raw.lagMbrs),
  };
}

function parseQvlanPage(html: string): Record<string, unknown> | null {
  const raw = extractJsObject(html, "qvlan_ds");
  if (!raw) {
    return null;
  }

  const portCount = asNumber(raw.portNum);
  const count = asNumber(raw.count) ?? 0;
  const vids = asNumberArray(raw.vids).slice(0, count || undefined);
  const names = asStringArray(raw.names);
  const tagMasks = asNumberArray(raw.tagMbrs);
  const untagMasks = asNumberArray(raw.untagMbrs);

  return {
    enabled: numberToBool(raw.state),
    port_count: portCount,
    count,
    max_vids: asNumber(raw.maxVids),
    vlans: vids.map((vid, index) => {
      const taggedMask = tagMasks[index] ?? 0;
      const untaggedMask = untagMasks[index] ?? 0;
      const taggedPorts = bitmaskToPorts(taggedMask, portCount);
      const untaggedPorts = bitmaskToPorts(untaggedMask, portCount);
      return {
        vid,
        name: names[index] ?? "",
        tagged_ports: taggedPorts,
        untagged_ports: untaggedPorts,
        member_ports: uniqueNumbers([...taggedPorts, ...untaggedPorts]),
        tagged_mask: taggedMask,
        untagged_mask: untaggedMask,
      };
    }),
    lag_ids: asNumberArray(raw.lagIds).slice(0, portCount ?? undefined),
    lag_members_raw: asNumberArray(raw.lagMbrs),
  };
}

function parsePvidPage(html: string): Record<string, unknown> | null {
  const raw = extractJsObject(html, "pvid_ds");
  if (!raw) {
    return null;
  }

  const portCount = asNumber(raw.portNum);
  const count = asNumber(raw.count) ?? 0;
  const vids = asNumberArray(raw.vids).slice(0, count || undefined);
  const masks = asNumberArray(raw.mbrs);
  const pvids = asNumberArray(raw.pvids);
  const membership = vids.map((vid, index) => {
    const mask = masks[index] ?? 0;
    return {
      vid,
      member_ports: bitmaskToPorts(mask, portCount),
      member_mask: mask,
    };
  });

  return {
    enabled: numberToBool(raw.state),
    port_count: portCount,
    vlan_ids: vids,
    ports: Array.from({ length: portCount ?? pvids.length }, (_, index) => {
      const port = index + 1;
      const pvid = pvids[index] ?? null;
      const vlanIndex = typeof pvid === "number" ? vids.indexOf(pvid) : -1;
      const mask = vlanIndex >= 0 ? masks[vlanIndex] ?? 0 : 0;
      return {
        port,
        pvid,
        pvid_exists: vlanIndex >= 0,
        pvid_member: vlanIndex >= 0 ? bitmaskToPorts(mask, portCount).includes(port) : false,
      };
    }),
    membership,
    lag_ids: asNumberArray(raw.lagIds).slice(0, portCount ?? undefined),
    lag_members_raw: asNumberArray(raw.lagMbrs),
  };
}

function parsePortTrunkPage(html: string): Record<string, unknown> | null {
  const trunk = extractJsObject(html, "trunk_conf");
  if (!trunk) {
    return null;
  }

  const maxTrunkNum = asNumber(trunk.maxTrunkNum) ?? 0;
  const portNumPerTrunk = asNumber(trunk.portNumPerTrunk);
  const groups = [];

  for (let group = 1; group <= maxTrunkNum; group += 1) {
    const members = asNumberArray(trunk[`portStr_g${group}`]).filter((port) => port > 0);
    groups.push({
      group,
      members,
      enabled: members.length > 0,
    });
  }

  return {
    max_groups: maxTrunkNum,
    port_count: asNumber(trunk.portNum),
    ports_per_group: portNumPerTrunk,
    port_reverse: asNumber(trunk.portReverse),
    groups,
  };
}

function describeWriteEndpoints(page: FormattedPage): Array<Record<string, unknown>> {
  return page.forms
    .map((form) => ({
      action: typeof form.action === "string" ? form.action : null,
      method: typeof form.method === "string" ? form.method.toUpperCase() : "GET",
      disabled: true,
      reason: "Read-only discovery mode; configuration forms are not submitted.",
      inputs: form.inputs,
    }))
    .filter((endpoint) => endpoint.action !== null);
}

function buildMtuVlanPlans(input: {
  enabled?: boolean;
  uplinkPort?: number;
}, mtu: Record<string, unknown> | null, token: string | null): CgiRequestPlan[] {
  const plans: CgiRequestPlan[] = [];
  const tokenValue = token ?? "<top.g_tid>";

  if (input.enabled !== undefined) {
    plans.push({
      description: `${input.enabled ? "Enable" : "Disable"} MTU VLAN`,
      action: "mtuVlanSet.cgi",
      method: "GET",
      referer: "VlanMtuRpm.htm",
      params: [
        ["mtu_en", input.enabled ? "1" : "0"],
        ["mtu_mode", VENDOR_APPLY_LABEL],
        ["token", tokenValue],
      ],
      will_submit: false,
    });
  }

  if (input.uplinkPort !== undefined) {
    plans.push({
      description: `Set MTU VLAN uplink port to ${input.uplinkPort}`,
      action: "mtuVlanSet.cgi",
      method: "GET",
      referer: "VlanMtuRpm.htm",
      params: [
        ["uplinkPort", String(input.uplinkPort)],
        ["mtu_uplink", VENDOR_APPLY_LABEL],
        ["token", tokenValue],
      ],
      will_submit: false,
    });
  }

  return plans.map((plan) => ({
    ...plan,
    description: mtu ? plan.description : `${plan.description} (page state was not parsed)`,
  }));
}

function validateMtuVlanPlans(input: {
  enabled?: boolean;
  uplinkPort?: number;
}, mtu: Record<string, unknown> | null, plans: CgiRequestPlan[]): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const portCount = asNumber(mtu?.port_count);
  const currentEnabled = mtu?.enabled === true;

  if (plans.length === 0) {
    errors.push("No MTU VLAN change was specified.");
  }

  if (input.uplinkPort !== undefined) {
    if (portCount !== null && (input.uplinkPort < 1 || input.uplinkPort > portCount)) {
      errors.push(`uplinkPort must be between 1 and ${portCount}.`);
    }
    if (!currentEnabled && input.enabled !== true) {
      errors.push("MTU VLAN is currently disabled; the Web UI script blocks setting only the uplink port.");
    }
    if (!currentEnabled && input.enabled === true) {
      warnings.push("The request plan will follow the Web UI flow: enable MTU VLAN first, then set the uplink port.");
    }
  }

  if (input.enabled === true && !currentEnabled) {
    warnings.push("The Web UI warns that enabling MTU VLAN automatically disables port VLAN and 802.1Q VLAN and clears their related configuration.");
  }

  if (input.enabled === false && currentEnabled) {
    warnings.push("The Web UI warns that disabling MTU VLAN discards its related configuration.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function buildPortVlanPlans(input: {
  enabled?: boolean;
  mode: "set" | "delete";
  vid?: number;
  ports: number[];
}, portVlan: Record<string, unknown> | null, token: string | null): CgiRequestPlan[] {
  const plans: CgiRequestPlan[] = [];
  const tokenValue = token ?? "<top.g_tid>";

  if (input.enabled !== undefined) {
    plans.push({
      description: `${input.enabled ? "Enable" : "Disable"} port VLAN`,
      action: "pvlanSet.cgi",
      method: "GET",
      referer: "VlanPortBasicRpm.htm",
      params: [
        ["pvlan_en", input.enabled ? "1" : "0"],
        ["pvlan_mode", VENDOR_APPLY_LABEL],
        ["token", tokenValue],
      ],
      will_submit: false,
    });
  }

  if (input.mode === "delete" && input.vid !== undefined) {
    plans.push({
      description: `Delete port VLAN ${input.vid}`,
      action: "pvlanSet.cgi",
      method: "GET",
      referer: "VlanPortBasicRpm.htm",
      params: [
        ["selVlans", String(input.vid)],
        ["pvlan_del", VENDOR_DELETE_LABEL],
        ["token", tokenValue],
      ],
      will_submit: false,
    });
  }

  if (input.mode === "set" && input.vid !== undefined) {
    plans.push({
      description: `Set port VLAN ${input.vid} member ports to ${uniqueNumbers(input.ports).join(",")}`,
      action: "pvlanSet.cgi",
      method: "GET",
      referer: "VlanPortBasicRpm.htm",
      params: [
        ["vid", String(input.vid)],
        ...uniqueNumbers(input.ports).map((port): [string, string] => ["selPorts", String(port)]),
        ["pvlan_add", VENDOR_APPLY_LABEL],
        ["token", tokenValue],
      ],
      will_submit: false,
    });
  }

  return plans.map((plan) => ({
    ...plan,
    description: portVlan ? plan.description : `${plan.description} (page state was not parsed)`,
  }));
}

function validatePortVlanPlans(input: {
  enabled?: boolean;
  mode: "set" | "delete";
  vid?: number;
  ports: number[];
}, portVlan: Record<string, unknown> | null, plans: CgiRequestPlan[]): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const portCount = asNumber(portVlan?.port_count) ?? 0;
  const currentEnabled = portVlan?.enabled === true;
  const editRequested = input.vid !== undefined || input.ports.length > 0 || input.mode === "delete";
  const ports = uniqueNumbers(input.ports);

  if (!portVlan) {
    warnings.push("Could not parse pvlan_ds from VlanPortBasicRpm.htm; validation is limited.");
  }
  if (plans.length === 0) {
    errors.push("No port VLAN change was specified.");
  }
  if (input.mode === "delete" && input.vid === undefined) {
    errors.push("delete mode requires vid.");
  }
  if (input.mode === "set" && (input.vid !== undefined || input.ports.length > 0)) {
    if (input.vid === undefined) {
      errors.push("set mode requires vid.");
    }
    if (ports.length === 0) {
      errors.push("set mode requires at least one member port.");
    }
  }
  if (input.ports.length !== ports.length) {
    errors.push("ports must not contain duplicates.");
  }
  if (input.vid !== undefined) {
    const maxVid = portCount || "?";
    if (input.vid < 1 || (portCount > 0 && input.vid > portCount)) {
      errors.push(`Port VLAN vid must be between 1 and ${maxVid}.`);
    }
  }
  for (const port of ports) {
    if (port < 1 || (portCount > 0 && port > portCount)) {
      errors.push(`Port ${port} is outside the allowed range 1-${portCount || "?"}.`);
    }
  }
  if (editRequested && !currentEnabled && input.enabled !== true) {
    errors.push("Port VLAN is currently disabled; the Web UI script blocks adding or deleting port VLANs.");
  }
  if (input.enabled === true && !currentEnabled) {
    warnings.push("The Web UI warns that enabling port VLAN automatically disables MTU VLAN and 802.1Q VLAN and clears their related configuration.");
  }
  if (input.enabled === false && editRequested) {
    warnings.push("This plan disables port VLAN and edits VLAN data at the same time; consider doing this in two steps.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function build8021qVlanPlans(input: {
  enabled?: boolean;
  mode: "set" | "delete";
  vid?: number;
  name?: string;
  untaggedPorts: number[];
  taggedPorts: number[];
}, qvlan: Record<string, unknown> | null, token: string | null): CgiRequestPlan[] {
  const plans: CgiRequestPlan[] = [];
  const tokenValue = token ?? "<top.g_tid>";

  if (input.enabled !== undefined) {
    plans.push({
      description: `${input.enabled ? "Enable" : "Disable"} 802.1Q VLAN`,
      action: "qvlanSet.cgi",
      method: "GET",
      referer: "Vlan8021QRpm.htm",
      params: [
        ["qvlan_en", input.enabled ? "1" : "0"],
        ["qvlan_mode", VENDOR_APPLY_LABEL],
        ["token", tokenValue],
      ],
      will_submit: false,
    });
  }

  if (input.mode === "delete" && input.vid !== undefined) {
    plans.push({
      description: `Delete 802.1Q VLAN ${input.vid}`,
      action: "qvlanSet.cgi",
      method: "GET",
      referer: "Vlan8021QRpm.htm",
      params: [
        ["selVlans", String(input.vid)],
        ["qvlan_del", VENDOR_DELETE_LABEL],
        ["token", tokenValue],
      ],
      will_submit: false,
    });
  }

  if (input.mode === "set" && input.vid !== undefined) {
    const existing = findParsedVlan(qvlan, input.vid);
    const suppliedPorts = input.untaggedPorts.length > 0 || input.taggedPorts.length > 0;
    const untaggedPorts = uniqueNumbers(suppliedPorts ? input.untaggedPorts : asNumberArray(existing?.untagged_ports));
    const taggedPorts = uniqueNumbers(suppliedPorts ? input.taggedPorts : asNumberArray(existing?.tagged_ports));
    const portCount = asNumber(qvlan?.port_count) ?? maxInputPort([...untaggedPorts, ...taggedPorts]);
    const untaggedSet = new Set(untaggedPorts);
    const taggedSet = new Set(taggedPorts);
    const portTypes: Array<[string, string]> = [];

    for (let port = 1; port <= portCount; port += 1) {
      const type = untaggedSet.has(port) ? "0" : taggedSet.has(port) ? "1" : "2";
      portTypes.push([`selType_${port}`, type]);
    }

    plans.push({
      description: `Set 802.1Q VLAN ${input.vid}: untagged=${untaggedPorts.join(",") || "-"} tagged=${taggedPorts.join(",") || "-"}`,
      action: "qvlanSet.cgi",
      method: "GET",
      referer: "Vlan8021QRpm.htm",
      params: [
        ["vid", String(input.vid)],
        ["vname", input.name ?? asString(existing?.name) ?? ""],
        ...portTypes,
        ["qvlan_add", VENDOR_ADD_EDIT_LABEL],
        ["token", tokenValue],
      ],
      will_submit: false,
    });
  }

  return plans.map((plan) => ({
    ...plan,
    description: qvlan ? plan.description : `${plan.description} (page state was not parsed)`,
  }));
}

function validate8021qVlanPlans(input: {
  enabled?: boolean;
  mode: "set" | "delete";
  vid?: number;
  name?: string;
  untaggedPorts: number[];
  taggedPorts: number[];
}, qvlan: Record<string, unknown> | null, plans: CgiRequestPlan[]): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const portCount = asNumber(qvlan?.port_count) ?? 0;
  const currentEnabled = qvlan?.enabled === true;
  const existing = input.vid === undefined ? null : findParsedVlan(qvlan, input.vid);
  const suppliedPorts = input.untaggedPorts.length > 0 || input.taggedPorts.length > 0;
  const untaggedPorts = uniqueNumbers(suppliedPorts ? input.untaggedPorts : asNumberArray(existing?.untagged_ports));
  const taggedPorts = uniqueNumbers(suppliedPorts ? input.taggedPorts : asNumberArray(existing?.tagged_ports));
  const members = uniqueNumbers([...untaggedPorts, ...taggedPorts]);
  const editRequested =
    input.vid !== undefined ||
    input.name !== undefined ||
    input.untaggedPorts.length > 0 ||
    input.taggedPorts.length > 0 ||
    input.mode === "delete";

  if (!qvlan) {
    warnings.push("Could not parse qvlan_ds from Vlan8021QRpm.htm; validation is limited.");
  }
  if (plans.length === 0) {
    errors.push("No 802.1Q VLAN change was specified.");
  }
  if (input.mode === "delete" && input.vid === undefined) {
    errors.push("delete mode requires vid.");
  }
  if (input.mode === "set" && editRequested) {
    if (input.vid === undefined) {
      errors.push("set mode requires vid.");
    }
    if (!suppliedPorts && existing) {
      warnings.push("No tagged or untagged ports were specified; the current VLAN member ports will be reused.");
    }
    if (!suppliedPorts && !existing) {
      errors.push("New VLANs require taggedPorts or untaggedPorts.");
    }
    if (members.length === 0) {
      errors.push("802.1Q VLAN requires at least one tagged or untagged member port.");
    }
  }
  if (input.vid !== undefined && (input.vid < 1 || input.vid > 4094)) {
    errors.push("802.1Q VLAN ID must be between 1 and 4094.");
  }
  if (input.name !== undefined && Array.from(input.name).length > 12) {
    errors.push("VLAN description must be at most 12 characters.");
  }
  if (input.untaggedPorts.length !== uniqueNumbers(input.untaggedPorts).length) {
    errors.push("untaggedPorts must not contain duplicates.");
  }
  if (input.taggedPorts.length !== uniqueNumbers(input.taggedPorts).length) {
    errors.push("taggedPorts must not contain duplicates.");
  }
  for (const port of members) {
    if (port < 1 || (portCount > 0 && port > portCount)) {
      errors.push(`Port ${port} is outside the allowed range 1-${portCount || "?"}.`);
    }
  }
  for (const port of input.untaggedPorts) {
    if (input.taggedPorts.includes(port)) {
      errors.push(`Port ${port} cannot be both tagged and untagged.`);
    }
  }
  if (editRequested && !currentEnabled && input.enabled !== true) {
    errors.push("802.1Q VLAN is currently disabled; the Web UI script blocks adding/deleting VLANs or setting PVID.");
  }
  if (input.enabled === true && !currentEnabled) {
    warnings.push("The Web UI warns that enabling 802.1Q VLAN automatically disables port VLAN and MTU VLAN and clears their related configuration.");
  }
  if (input.mode === "set" && input.vid !== undefined && !existing) {
    const count = asNumber(qvlan?.count);
    const maxVids = asNumber(qvlan?.max_vids);
    if (count !== null && maxVids !== null && count >= maxVids) {
      errors.push(`The current VLAN count has reached the Web UI limit of ${maxVids}.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function buildPvidPlans(input: {
  pvid: number;
  ports: number[];
}, pvid: Record<string, unknown> | null, token: string | null): CgiRequestPlan[] {
  const tokenValue = token ?? "<top.g_tid>";
  const ports = uniqueNumbers(input.ports);

  return [{
    description: `Set PVID ${input.pvid} on ports ${ports.join(",")}`,
    action: "vlanPvidSet.cgi",
    method: "GET" as const,
    referer: "Vlan8021QPvidRpm.htm",
    params: [
      ["pbm", String(portsToBitmask(ports))] as [string, string],
      ["pvid", String(input.pvid)] as [string, string],
      ["token", tokenValue] as [string, string],
    ],
    will_submit: false,
  }].map((plan) => ({
    ...plan,
    description: pvid ? plan.description : `${plan.description} (page state was not parsed)`,
  }));
}

function validatePvidPlans(input: {
  pvid: number;
  ports: number[];
}, pvid: Record<string, unknown> | null, plans: CgiRequestPlan[]): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const portCount = asNumber(pvid?.port_count) ?? 0;
  const ports = uniqueNumbers(input.ports);
  const vlanIds = asNumberArray(pvid?.vlan_ids);

  if (!pvid) {
    warnings.push("Could not parse pvid_ds from Vlan8021QPvidRpm.htm; validation is limited.");
  }
  if (plans.length === 0) {
    errors.push("No PVID change was specified.");
  }
  if (input.pvid < 1 || input.pvid > 4094) {
    errors.push("PVID must be between 1 and 4094.");
  }
  if (ports.length === 0) {
    errors.push("At least one port is required.");
  }
  if (ports.length !== input.ports.length) {
    errors.push("ports must not contain duplicates.");
  }
  for (const port of ports) {
    if (port < 1 || (portCount > 0 && port > portCount)) {
      errors.push(`Port ${port} is outside the allowed range 1-${portCount || "?"}.`);
    }
  }
  if (pvid?.enabled === false) {
    errors.push("802.1Q VLAN is currently disabled; the Web UI script blocks setting PVID.");
  }
  if (vlanIds.length > 0 && !vlanIds.includes(input.pvid)) {
    errors.push(`PVID ${input.pvid} is not in the current 802.1Q VLAN list.`);
  }
  const requestedMembership = findParsedMembership(pvid, input.pvid);
  const requestedMemberPorts = asNumberArray(requestedMembership?.member_ports);
  for (const port of ports) {
    if (requestedMembership && !requestedMemberPorts.includes(port)) {
      warnings.push(`Port ${port} is not a member of VLAN ${input.pvid}; the Web UI may warn that the PVID and VLAN membership are inconsistent.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function discoverSaveConfigEndpoint(html: string): SaveConfigDiscovery {
  const root = parse(html || "<html></html>", {
    lowerCaseTagName: true,
    comment: false,
  });

  for (const form of root.querySelectorAll("form")) {
    const action = form.getAttribute("action");
    const method = normalizeMethod(form.getAttribute("method"));
    const text = cleanText(`${form.text} ${form.toString()}`);
    if (!action || !looksLikeSaveConfigAction(action, text)) {
      continue;
    }
    const parsed = splitActionAndParams(action);
    const params = form.querySelectorAll("input,button").flatMap((input): Array<[string, string]> => {
      const name = input.getAttribute("name");
      if (!name || name === "token") {
        return [];
      }
      const type = (input.getAttribute("type") ?? "").toLowerCase();
      const value = input.getAttribute("value") ?? cleanText(input.text) ?? "";
      if (type === "submit" || type === "button") {
        return new RegExp(`${VENDOR_SAVE_TEXT}|save`, "i").test(value) ? [[name, value]] : [];
      }
      if (name === "action_op" && !value && /action_op\.value\s*=\s*["']save["']/i.test(html)) {
        return [[name, "save"]];
      }
      return [[name, value]];
    });
    return {
      ...parsed,
      method,
      params: [...parsed.params, ...params],
      source: "form",
      confidence: "high",
    };
  }

  const scriptCandidates = [
    ...html.matchAll(/location\.href\s*=\s*["']([^"']*savingconfig[^"']*?\.cgi(?:\?[^"']*)?)["']/gi),
    ...html.matchAll(/["']([^"']*savingconfig[^"']*?\.cgi(?:\?[^"']*)?)["']/gi),
  ];
  for (const match of scriptCandidates) {
    const action = match[1] ?? "";
    if (looksLikeSaveConfigAction(action, html.slice(Math.max(0, match.index - 80), match.index + 160))) {
      return {
        ...splitActionAndParams(action),
        method: "GET",
        source: "script",
        confidence: "medium",
      };
    }
  }

  return {
    action: "savingconfig.cgi",
    method: "POST",
    params: [["action_op", "save"]],
    source: "fallback",
    confidence: "fallback",
    note: "Could not discover a save form from SavingConfigRpm.htm; using the save-configuration CGI candidate from the current TP-Link/Mercury page samples.",
  };
}

function buildSaveConfigurationPlans(discovery: SaveConfigDiscovery, token: string | null): CgiRequestPlan[] {
  const tokenValue = token ?? "<top.g_tid>";
  const params = discovery.params.filter(([key]) => key !== "token");

  return [{
    description: "Save the current running configuration to the device startup configuration",
    action: discovery.action,
    method: discovery.method,
    referer: "SavingConfigRpm.htm",
    params: [
      ...params,
      ["token", tokenValue],
    ],
    will_submit: false,
  }];
}

function validateSaveConfigurationPlans(
  discovery: SaveConfigDiscovery,
  pageError: string | undefined,
  plans: CgiRequestPlan[],
): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const riskyPattern = /restore|reset|factory|reboot|upgrade|upload|import|backup|back/i;

  if (plans.length !== 1) {
    errors.push("The save-configuration request plan is invalid.");
  }
  if (!/savingconfig\.cgi$/i.test(discovery.action)) {
    errors.push(`The discovered save endpoint ${discovery.action} is not the savingconfig.cgi endpoint used by SavingConfigRpm.htm; refusing to submit.`);
  }
  if (!discovery.params.some(([key, value]) => key === "action_op" && value === "save")) {
    errors.push('The save-configuration request must include action_op: "save".');
  }
  if (riskyPattern.test(discovery.action)) {
    errors.push(`The discovered save endpoint ${discovery.action} does not look like a running-configuration save endpoint; refusing to submit.`);
  }
  if (pageError) {
    warnings.push(`Failed to read SavingConfigRpm.htm: ${pageError}`);
  }
  if (discovery.note) {
    warnings.push(discovery.note);
  }
  if (discovery.confidence !== "high") {
    warnings.push(`The save-configuration endpoint source is ${discovery.source}; compare the dry-run output with the page before submitting for real.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    discovery,
  };
}

function buildTrunkPlans(input: {
  group: number;
  ports: number[];
  mode: "set" | "delete";
}, trunk: Record<string, unknown> | null, token: string | null): CgiRequestPlan[] {
  const tokenValue = token ?? "<top.g_tid>";

  if (input.mode === "delete") {
    return [{
      description: `Delete trunk group ${input.group}`,
      action: "port_trunk_display.cgi",
      method: "GET" as const,
      referer: "PortTrunkRpm.htm",
      params: [
        ["chk_trunk", String(input.group)] as [string, string],
        ["setDelete", VENDOR_DELETE_LABEL] as [string, string],
        ["token", tokenValue] as [string, string],
      ],
      will_submit: false,
    }];
  }

  return [{
    description: `Set trunk group ${input.group} member ports to ${input.ports.join(",")}`,
    action: "port_trunk_set.cgi",
    method: "GET" as const,
    referer: "PortTrunkRpm.htm",
    params: [
      ["groupId", String(input.group)] as [string, string],
      ...input.ports.map((port): [string, string] => ["portid", String(port)]),
      ["setapply", VENDOR_APPLY_LABEL] as [string, string],
      ["token", tokenValue] as [string, string],
    ],
    will_submit: false,
  }].map((plan) => ({
    ...plan,
    description: trunk ? plan.description : `${plan.description} (page state was not parsed)`,
  }));
}

function validateTrunkPlans(input: {
  group: number;
  ports: number[];
  mode: "set" | "delete";
}, trunk: Record<string, unknown> | null): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxGroups = asNumber(trunk?.max_groups) ?? 0;
  const portCount = asNumber(trunk?.port_count) ?? 0;
  const portsPerGroup = asNumber(trunk?.ports_per_group) ?? 4;

  if (!trunk) {
    warnings.push("Could not parse trunk_conf from PortTrunkRpm.htm; validation is limited.");
  }

  if (maxGroups > 0 && (input.group < 1 || input.group > maxGroups)) {
    errors.push(`group must be between 1 and ${maxGroups}.`);
  }

  if (input.mode === "delete") {
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  const uniquePorts = [...new Set(input.ports)];
  if (uniquePorts.length !== input.ports.length) {
    errors.push("ports must not contain duplicates.");
  }
  if (uniquePorts.length < 2) {
    errors.push("The Web UI script requires at least 2 ports in a trunk group.");
  }
  if (uniquePorts.length > portsPerGroup) {
    errors.push(`The Web UI script allows at most ${portsPerGroup} ports per trunk group.`);
  }
  for (const port of uniquePorts) {
    if (port < 1 || (portCount > 0 && port > portCount)) {
      errors.push(`Port ${port} is outside the allowed range 1-${portCount || "?"}.`);
    }
    if ((port <= 4 || port >= 9) && input.group === 2) {
      errors.push("The Web UI script restricts LAG2 to ports 5 through 8.");
    }
    if (port >= 5 && input.group === 1) {
      errors.push("The Web UI script restricts LAG1 to ports 1 through 4.");
    }
    if (port <= 8 && input.group === 3) {
      errors.push("The Web UI script restricts LAG3 to ports 9 through 10.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function dryRunResult(
  target: string,
  operation: string,
  login: Record<string, unknown>,
  validation: Record<string, unknown>,
  plans: CgiRequestPlan[],
  source: Record<string, unknown>,
): Record<string, unknown> {
  return {
    target,
    operation,
    dry_run: true,
    will_submit: false,
    login: summarizeLogin(login),
    validation,
    requests: plans,
    source,
  };
}

function applyResult(
  target: string,
  operation: string,
  login: Record<string, unknown>,
  validation: Record<string, unknown>,
  plans: CgiRequestPlan[],
  responses: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    target,
    operation,
    dry_run: false,
    submitted: true,
    login: summarizeLogin(login),
    validation,
    requests: plans.map((plan) => ({ ...plan, will_submit: true })),
    responses,
  };
}

function ensureWriteAllowed(
  confirm: string | undefined,
  validation: Record<string, unknown>,
  token: string | null,
  login: Record<string, unknown>,
): void {
  if (confirm !== "APPLY") {
    throw new Error('Real writes require confirm: "APPLY".');
  }
  if (login.success_hint !== true) {
    throw new Error("Real writes require a successful login first.");
  }
  if (validation.valid !== true) {
    throw new Error(`The request did not pass Web UI rule validation: ${JSON.stringify(validation)}`);
  }
  if (!token) {
    throw new Error("Could not read top.g_tid/token from the page; refusing to submit a real write.");
  }
}

function buildPorts(raw: Record<string, unknown>, maxPortNum: number): Array<Record<string, unknown>> {
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

function extractJsObject(html: string, name: string): Record<string, unknown> | null {
  const startMatch = new RegExp(`var\\s+${name}\\s*=\\s*\\{`, "m").exec(html);
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }

  const objectStart = html.indexOf("{", startMatch.index);
  const objectEnd = findMatchingBrace(html, objectStart);
  if (objectStart === -1 || objectEnd === -1) {
    return null;
  }

  const objectText = html.slice(objectStart, objectEnd + 1);
  const jsonText = objectText
    .replace(/\b0x([0-9a-fA-F]+)\b/g, (_, hex: string) => String(Number.parseInt(hex, 16)))
    .replace(/([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/'/g, '"');

  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractJsNumber(html: string, name: string): number | null {
  const match = html.match(new RegExp(`var\\s+${name}\\s*=\\s*"?(-?\\d+)"?`, "m"));
  return match ? Number(match[1]) : null;
}

function firstString(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

function numberToBool(value: unknown): boolean | null {
  const number = asNumber(value);
  return number === null ? null : number === 1;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function bitmaskToPorts(mask: number | null | undefined, portCount: number | null | undefined): number[] {
  if (typeof mask !== "number" || !Number.isFinite(mask)) {
    return [];
  }
  const count = portCount ?? 32;
  const ports = [];
  for (let port = 1; port <= count; port += 1) {
    if ((mask & (1 << (port - 1))) !== 0) {
      ports.push(port);
    }
  }
  return ports;
}

function portsToBitmask(ports: number[]): number {
  return uniqueNumbers(ports).reduce((mask, port) => mask | (1 << (port - 1)), 0);
}

function maxInputPort(ports: number[]): number {
  return Math.max(0, ...ports.filter((port) => Number.isInteger(port) && port > 0));
}

function valueAt(value: unknown, index: number): number | null {
  return Array.isArray(value) && typeof value[index] === "number" ? value[index] : null;
}

function portType(code: number | null): string {
  if (code === 0) {
    return "rj45";
  }
  if (code === 1) {
    return "sfp";
  }
  return `unknown(${code})`;
}

function parsePortList(value: string | undefined): number[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function parseTrunkMode(value: string | undefined): "set" | "delete" {
  if (value === undefined || value === "" || value === "set") {
    return "set";
  }
  if (value === "delete") {
    return "delete";
  }
  throw new Error('mode must be "set" or "delete".');
}

function parseVlanEditMode(value: string | undefined): "set" | "delete" {
  if (value === undefined || value === "" || value === "set") {
    return "set";
  }
  if (value === "delete") {
    return "delete";
  }
  throw new Error('mode must be "set" or "delete".');
}

function findParsedVlan(vlan: Record<string, unknown> | null, vid: number): Record<string, unknown> | null {
  const vlans = Array.isArray(vlan?.vlans) ? vlan.vlans : [];
  for (const item of vlans) {
    if (isRecord(item) && item.vid === vid) {
      return item;
    }
  }
  return null;
}

function findParsedPort(page: Record<string, unknown> | null, port: number): Record<string, unknown> | null {
  const ports = Array.isArray(page?.ports) ? page.ports : [];
  for (const item of ports) {
    if (isRecord(item) && item.port === port) {
      return item;
    }
  }
  return null;
}

function findParsedMembership(page: Record<string, unknown> | null, vid: number): Record<string, unknown> | null {
  const memberships = Array.isArray(page?.membership) ? page.membership : [];
  for (const item of memberships) {
    if (isRecord(item) && item.vid === vid) {
      return item;
    }
  }
  return null;
}

function looksLikeSaveConfigAction(action: string, context: string): boolean {
  const text = `${action} ${context}`.toLowerCase();
  const hasSave = new RegExp(`save|${VENDOR_SAVE_TEXT}`).test(text);
  const hasConfig = new RegExp(`config|cfg|${VENDOR_CONFIG_TEXT}`).test(text);
  const risky = new RegExp(`backup|restore|reset|factory|reboot|upgrade|upload|import|${VENDOR_RISKY_TEXT_PATTERN}`).test(text);
  return hasSave && hasConfig && !risky;
}

function splitActionAndParams(action: string): { action: string; params: Array<[string, string]> } {
  const normalized = action.replace(/^\//, "");
  const question = normalized.indexOf("?");
  if (question === -1) {
    return {
      action: normalized,
      params: [],
    };
  }

  const path = normalized.slice(0, question);
  const query = normalized.slice(question + 1).replace(/\+.*$/g, "");
  const params = [...new URLSearchParams(query).entries()]
    .filter(([key, value]) => key && value && !/top\.g_tid|g_tid/i.test(value));

  return {
    action: path,
    params,
  };
}

function normalizeMethod(method: string | null | undefined): "GET" | "POST" {
  return method?.toUpperCase() === "POST" ? "POST" : "GET";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyToString(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString();
  }
  throw new Error("Unsupported request body type");
}

function extractTitle(html: string): string | null {
  return formatHtmlPage(html).title;
}

function extractNumberVar(html: string, name: string): number | null {
  const match = html.match(new RegExp(`var\\s+${name}\\s*=\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : null;
}

function extractLogonErrorCode(html: string): number | null {
  const match = html.match(/logonInfo\s*=\s*new Array\(\s*([\d-]+)/i);
  return match ? Number(match[1]) : null;
}

function extractToken(html: string): string | null {
  const patterns = [
    /(?:top\.)?g_tid\s*=\s*["']([^"']+)["']/i,
    /name=["']token["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']token["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function htmlToText(html: string): string {
  return formatHtmlPage(html).text;
}

function looksLikeLoginPage(text: string): boolean {
  return /submitForm|plain_password|logonInfo\s*=\s*new Array\(\s*[1-9]/i.test(text);
}

function isMeaningfulPage(html: string, page: FormattedPage): boolean {
  if (looksLikeLoginPage(html)) {
    return false;
  }
  if (page.forms.length > 0 || page.frames.length > 0 || page.links.length > 0 || page.scripts.length > 0 || page.tables.length > 0) {
    return true;
  }
  if (page.text.length < 30) {
    return false;
  }
  if (new RegExp(`^Copyright\\s*&copy;\\s*${VENDOR_COPYRIGHT_TEXT_PATTERN}$`, "i").test(page.text)) {
    return false;
  }
  return true;
}

function formatHtmlPage(html: string): FormattedPage {
  const expandedHtml = `${html}\n${extractDocumentWriteHtml(html)}`;
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
  });
  const expandedRoot = expandedHtml === html ? root : parse(expandedHtml, {
    lowerCaseTagName: true,
    comment: false,
  });

  const scripts = expandedRoot.querySelectorAll("script").slice(0, 50).map((script) => ({
    src: script.getAttribute("src") ?? null,
  }));

  expandedRoot.querySelectorAll("script,style,noscript").forEach((node) => node.remove());

  const title = cleanText(expandedRoot.querySelector("title")?.text ?? "") || null;
  const text = cleanText(expandedRoot.text);
  const forms = expandedRoot.querySelectorAll("form").slice(0, 8).map((form) => ({
    action: form.getAttribute("action") ?? null,
    method: form.getAttribute("method") ?? "GET",
    inputs: form.querySelectorAll("input,select,textarea").slice(0, 40).map((input) => ({
      tag: input.tagName.toLowerCase(),
      type: input.getAttribute("type") ?? null,
      name: input.getAttribute("name") ?? null,
      id: input.getAttribute("id") ?? null,
      value: input.getAttribute("type") === "password" ? undefined : input.getAttribute("value"),
    })),
  }));

  const frames = expandedRoot.querySelectorAll("frame,iframe").slice(0, 30).map((frame) => ({
    name: frame.getAttribute("name") ?? null,
    id: frame.getAttribute("id") ?? null,
    src: frame.getAttribute("src") ?? null,
  }));

  const links = expandedRoot.querySelectorAll("a").slice(0, 40).map((link) => ({
    text: cleanText(link.text) || null,
    href: link.getAttribute("href") ?? null,
  }));

  const tables = expandedRoot.querySelectorAll("table").slice(0, 5).map((table) =>
    table.querySelectorAll("tr").slice(0, 20).map((row) =>
      row.querySelectorAll("th,td").slice(0, 12).map((cell) => cleanText(cell.text)).filter(Boolean).join(" | "),
    ).filter(Boolean),
  ).filter((rows) => rows.length > 0);

  return { title, text, forms, frames, links, scripts, tables };
}

function extractCandidatePaths(page: FormattedPage): string[] {
  const values = [
    ...page.frames.map((frame) => frame.src),
    ...page.links.map((link) => link.href),
    ...page.scripts.map((script) => script.src),
    ...page.forms.map((form) => typeof form.action === "string" ? form.action : null),
  ];
  const paths = values
    .filter((value): value is string => Boolean(value))
    .filter((value) => !/^javascript:/i.test(value))
    .map((value) => {
      try {
        return new URL(value, "http://placeholder").pathname;
      } catch {
        return value.startsWith("/") ? value : `/${value}`;
      }
    });
  return [...new Set(paths)];
}

function filterStatusCandidatePaths(paths: unknown[]): string[] {
  return uniquePaths(
    paths
      .filter((path): path is string => typeof path === "string")
      .filter((path) => /\.(?:htm|html|js)$/i.test(path))
      .filter((path) => /mainrpm|statusrpm|sysstatus|systeminfo|product|top|menu|tab|frame|port/i.test(path)),
  );
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function extractDocumentWriteHtml(html: string): string {
  const snippets: string[] = [];
  const pattern = /document\.write\(\s*(['"])((?:\\.|(?!\1)[\s\S])*)\1\s*\)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    snippets.push(unescapeJsString(match[2] ?? ""));
  }

  return snippets.join("\n");
}

function unescapeJsString(value: string): string {
  return value
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\(["'\\\/bfnrt])/g, (_, char: string) => {
      const map: Record<string, string> = {
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      return map[char] ?? char;
    });
}

function cleanText(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function timeoutMs(): number {
  const parsed = Number(process.env.TPLINK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs(), () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
