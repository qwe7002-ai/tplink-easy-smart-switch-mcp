import { VENDOR_LOGIN_LABEL } from "./constants.js";
import { httpRequest, normalizeTarget, encodeTplinkPassword, tcpOpen } from "./http.js";
import { rememberCookies, cookieHeader, clearSession } from "./session.js";
import {
  parseMainRpmPage,
  parseVlanMtuPage,
  parsePortVlanPage,
  parseQvlanPage,
  parsePvidPage,
  parsePortTrunkPage,
  formatHtmlPage,
  discoverSaveConfigEndpoint,
  describeWriteEndpoints,
  extractCandidatePaths,
  filterStatusCandidatePaths,
  isMeaningfulPage,
  looksLikeLoginPage,
  extractToken,
  extractNumberVar,
  extractLogonErrorCode,
  htmlToText,
} from "./parsers.js";
import {
  buildMtuVlanPlans,
  validateMtuVlanPlans,
  buildPortVlanPlans,
  validatePortVlanPlans,
  build8021qVlanPlans,
  validate8021qVlanPlans,
  buildPvidPlans,
  validatePvidPlans,
  buildSaveConfigurationPlans,
  validateSaveConfigurationPlans,
  buildTrunkPlans,
  validateTrunkPlans,
  dryRunResult,
  applyResult,
  ensureWriteAllowed,
  buildStatusResponse,
  summarizeLogin,
} from "./plans.js";
import { uniquePaths } from "./utils.js";
import type { HttpResult, CgiRequestPlan } from "./types.js";

export class SwitchClient {
  readonly target: URL;

  constructor(host?: string) {
    this.target = normalizeTarget(host);
  }

  async getSwitchStatus(username?: string, password?: string, debug = false) {
    const httpOpen = await tcpOpen(this.target.hostname, 80);
    if (!httpOpen) {
      return { target: this.target.origin, reachable: false, error: "HTTP 80 is not reachable" };
    }

    const loginPage = await this.fetchText("/");
    const statusPaths = [
      "/MainRpm.htm", "/MainRpm.js", "/Top.htm", "/Product.htm", "/Menu.htm",
      "/tab.htm", "/StatusRpm.htm", "/userRpm/StatusRpm.htm",
      "/userRpm/SysStatusRpm.htm", "/userRpm/SystemInfoRpm.htm",
      "/frame.htm", "/mainFrame.htm",
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
      "/MainRpm.htm", "/MainRpm.js", "/userRpm/PortStatusRpm.htm",
      "/userRpm/PortConfigRpm.htm", "/PortStatusRpm.htm", "/PortConfigRpm.htm", "/mainFrame.htm",
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
        ...filterStatusCandidatePaths(discoveredPaths).filter((path) =>
          /mainrpm|port|status|state|link|frame/i.test(path),
        ),
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

    // Fetch all VLAN pages in parallel — they are independent reads.
    const [main, portVlan, qvlan, pvid, mtu] = await Promise.all([
      this.fetchText("/MainRpm.htm"),
      this.fetchText("/VlanPortBasicRpm.htm"),
      this.fetchText("/Vlan8021QRpm.htm"),
      this.fetchText("/Vlan8021QPvidRpm.htm"),
      this.fetchText("/VlanMtuRpm.htm"),
    ]);

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
      source: { path: "/PortTrunkRpm.htm", status: page.status },
      ...(debug ? { debug: { page: formatted } } : {}),
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
    for (const plan of plans) responses.push(await this.submitPlan(plan));
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
    for (const plan of plans) responses.push(await this.submitPlan(plan));
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
    for (const plan of plans) responses.push(await this.submitPlan(plan));
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
    for (const plan of plans) responses.push(await this.submitPlan(plan));
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
    for (const plan of plans) responses.push(await this.submitPlan(plan));
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
    for (const plan of plans) responses.push(await this.submitPlan(plan));
    return applyResult(this.target.origin, "save_configuration", login, validation, plans, responses);
  }

  async loginIfPossible(username?: string, password?: string) {
    const user = username ?? process.env.TPLINK_USERNAME;
    const pass = password ?? process.env.TPLINK_PASSWORD;

    if (!user || !pass) {
      return {
        attempted: false,
        message: "No username or password was provided. Only information visible without login is returned. You can set TPLINK_USERNAME/TPLINK_PASSWORD.",
      };
    }

    // Clear any stale session before re-authenticating to avoid cookie accumulation.
    clearSession(this.target);

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
        if (token) return token;
      } catch {
        // Keep trying; some firmware closes protected pages.
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

    return { path: null, status: null, title: null, text: "", tried };
  }

  private async fetchText(path: string) {
    const response = await this.fetch(path, { method: "GET" });
    rememberCookies(this.target, response);
    return { status: response.status, body: response.body };
  }

  private async fetch(
    path: string,
    options: { method: "GET" | "POST"; body?: BodyInit | null; headers?: Record<string, string> },
  ): Promise<HttpResult> {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.target.origin);
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const cookies = cookieHeader(this.target);
    if (cookies) headers.Cookie = cookies;

    return httpRequest(url, { method: options.method, headers, body: options.body });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
