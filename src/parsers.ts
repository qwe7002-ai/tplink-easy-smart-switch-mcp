import { parse } from "node-html-parser";
import { VENDOR_SAVE_TEXT, VENDOR_CONFIG_TEXT, VENDOR_RISKY_TEXT_PATTERN, VENDOR_COPYRIGHT_TEXT_PATTERN } from "./constants.js";
import {
  asNumber, asNumberArray, asStringArray, firstString, numberToBool, arrayLength,
  bitmaskToPorts, buildPorts, isRecord,
} from "./utils.js";
import type { FormattedPage, SaveConfigDiscovery } from "./types.js";

export function parseMainRpmPage(html: string): Record<string, unknown> | null {
  const info = extractJsObject(html, "info_ds");
  const ports = extractJsObject(html, "port_info");
  const vlan = extractJsObject(html, "qvlan_ds");
  const maxPortNum = extractJsNumber(html, "max_port_num") ?? arrayLength(ports?.state);

  if (!info && !ports && !vlan) return null;

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

export function parseVlanMtuPage(html: string): Record<string, unknown> | null {
  const mtu = extractJsObject(html, "mtu_ds");
  if (!mtu) return null;

  return {
    enabled: numberToBool(mtu.state),
    port_count: asNumber(mtu.portNum),
    uplink_port: asNumber(mtu.uplinkPort),
  };
}

export function parsePortVlanPage(html: string): Record<string, unknown> | null {
  const raw = extractJsObject(html, "pvlan_ds");
  if (!raw) return null;

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
      return { vid, member_ports: bitmaskToPorts(mask, portCount), member_mask: mask };
    }),
    lag_ids: asNumberArray(raw.lagIds).slice(0, portCount ?? undefined),
    lag_members_raw: asNumberArray(raw.lagMbrs),
  };
}

export function parseQvlanPage(html: string): Record<string, unknown> | null {
  const raw = extractJsObject(html, "qvlan_ds");
  if (!raw) return null;

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
        member_ports: [...new Set([...taggedPorts, ...untaggedPorts])].sort((a, b) => a - b),
        tagged_mask: taggedMask,
        untagged_mask: untaggedMask,
      };
    }),
    lag_ids: asNumberArray(raw.lagIds).slice(0, portCount ?? undefined),
    lag_members_raw: asNumberArray(raw.lagMbrs),
  };
}

export function parsePvidPage(html: string): Record<string, unknown> | null {
  const raw = extractJsObject(html, "pvid_ds");
  if (!raw) return null;

  const portCount = asNumber(raw.portNum);
  const count = asNumber(raw.count) ?? 0;
  const vids = asNumberArray(raw.vids).slice(0, count || undefined);
  const masks = asNumberArray(raw.mbrs);
  const pvids = asNumberArray(raw.pvids);
  const membership = vids.map((vid, index) => {
    const mask = masks[index] ?? 0;
    return { vid, member_ports: bitmaskToPorts(mask, portCount), member_mask: mask };
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

const MAC_RE = /^[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}$/;

export function normalizeMac(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!MAC_RE.test(trimmed)) return null;
  return trimmed.replace(/-/g, ":").toUpperCase();
}

export interface MacTableEntry {
  mac: string;
  port: number | null;
  vlan: number | null;
  type: string | null;
}

export interface MacTableResult {
  readable: boolean;
  count: number;
  entries: MacTableEntry[];
  source: "js_object" | "html_table" | "none";
  note?: string;
}

// The MAC address table page (MacSearchRpm.htm) is not part of the captured
// samples and its exact JS variable name differs across firmware. Rather than
// hard-code a name, anchor on the array of MAC-address strings and pair it with
// sibling arrays for port/vlan/type. Falls back to the rendered HTML table.
export function parseMacTablePage(html: string): MacTableResult {
  const jsResult = parseMacTableFromJs(html);
  if (jsResult) return jsResult;

  const tableResult = parseMacTableFromHtml(html);
  if (tableResult) return tableResult;

  return {
    readable: false,
    count: 0,
    entries: [],
    source: "none",
    note: "Could not locate a MAC address table on the page. The address table may be empty, require a search query, or use an unrecognized layout; re-run with debug to capture the raw page.",
  };
}

function parseMacTableFromJs(html: string): MacTableResult | null {
  const names = new Set<string>();
  for (const match of html.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g)) {
    if (match[1]) names.add(match[1]);
  }

  for (const name of names) {
    const obj = extractJsObject(html, name);
    if (!obj) continue;

    // Find the property whose value is an array dominated by MAC strings.
    let macKey: string | null = null;
    let macs: Array<string | null> = [];
    for (const [key, value] of Object.entries(obj)) {
      if (!Array.isArray(value)) continue;
      const normalized = value.map(normalizeMac);
      const hits = normalized.filter((m) => m !== null).length;
      if (hits > 0 && hits >= Math.ceil(value.length / 2)) {
        macKey = key;
        macs = normalized;
        break;
      }
    }
    if (!macKey) continue;

    const portArr = pickSiblingArray(obj, macKey, macs.length, /port|prt/i);
    const vlanArr = pickSiblingArray(obj, macKey, macs.length, /vlan|vid|fid/i);
    const typeArr = pickSiblingArray(obj, macKey, macs.length, /type|state|status|sta/i);

    const entries: MacTableEntry[] = [];
    macs.forEach((mac, index) => {
      if (mac === null) return;
      entries.push({
        mac,
        port: asNumber(portArr?.[index]),
        vlan: asNumber(vlanArr?.[index]),
        type: typeArr?.[index] !== undefined ? String(typeArr[index]) : null,
      });
    });

    if (entries.length > 0) {
      return { readable: true, count: entries.length, entries, source: "js_object" };
    }
  }

  return null;
}

// Pull a sibling array of the expected length, preferring keys that match the
// hint pattern, then falling back to the first numeric array of equal length.
function pickSiblingArray(
  obj: Record<string, unknown>,
  excludeKey: string,
  length: number,
  hint: RegExp,
): unknown[] | null {
  let fallback: unknown[] | null = null;
  for (const [key, value] of Object.entries(obj)) {
    if (key === excludeKey || !Array.isArray(value) || value.length !== length) continue;
    if (!value.some((item) => typeof item === "number")) continue;
    if (hint.test(key)) return value;
    if (fallback === null) fallback = value;
  }
  return fallback;
}

function parseMacTableFromHtml(html: string): MacTableResult | null {
  const root = parse(html, { lowerCaseTagName: true, comment: false });
  const entries: MacTableEntry[] = [];

  for (const row of root.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("th,td").map((cell) => cleanText(cell.text));
    const macCell = cells.find((cell) => normalizeMac(cell) !== null);
    const mac = normalizeMac(macCell);
    if (!mac) continue;
    const numbers = cells
      .filter((cell) => cell !== macCell && /^\d+$/.test(cell))
      .map((cell) => Number(cell));
    // Convention on these pages: VLAN/FID column precedes the port column.
    const vlan = numbers.length >= 2 ? numbers[0] : null;
    const port = numbers.length >= 2 ? numbers[1] : numbers[0] ?? null;
    entries.push({ mac, port: port ?? null, vlan, type: null });
  }

  if (entries.length === 0) return null;
  return {
    readable: true,
    count: entries.length,
    entries,
    source: "html_table",
    note: "Parsed from the rendered HTML table; verify the VLAN/port column order against the device.",
  };
}

export function parsePortTrunkPage(html: string): Record<string, unknown> | null {
  const trunk = extractJsObject(html, "trunk_conf");
  if (!trunk) return null;

  const maxTrunkNum = asNumber(trunk.maxTrunkNum) ?? 0;
  const portNumPerTrunk = asNumber(trunk.portNumPerTrunk);
  const groups = [];

  for (let group = 1; group <= maxTrunkNum; group += 1) {
    const members = asNumberArray(trunk[`portStr_g${group}`]).filter((port) => port > 0);
    groups.push({ group, members, enabled: members.length > 0 });
  }

  return {
    max_groups: maxTrunkNum,
    port_count: asNumber(trunk.portNum),
    ports_per_group: portNumPerTrunk,
    port_reverse: asNumber(trunk.portReverse),
    groups,
  };
}

export function formatHtmlPage(html: string): FormattedPage {
  const expandedHtml = `${html}\n${extractDocumentWriteHtml(html)}`;
  const root = parse(html, { lowerCaseTagName: true, comment: false });
  const expandedRoot = expandedHtml === html
    ? root
    : parse(expandedHtml, { lowerCaseTagName: true, comment: false });

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

  const tables = expandedRoot
    .querySelectorAll("table")
    .slice(0, 5)
    .map((table) =>
      table
        .querySelectorAll("tr")
        .slice(0, 20)
        .map((row) =>
          row
            .querySelectorAll("th,td")
            .slice(0, 12)
            .map((cell) => cleanText(cell.text))
            .filter(Boolean)
            .join(" | "),
        )
        .filter(Boolean),
    )
    .filter((rows) => rows.length > 0);

  return { title, text, forms, frames, links, scripts, tables };
}

export function discoverSaveConfigEndpoint(html: string): SaveConfigDiscovery {
  const root = parse(html || "<html></html>", { lowerCaseTagName: true, comment: false });

  for (const form of root.querySelectorAll("form")) {
    const action = form.getAttribute("action");
    const method = normalizeMethod(form.getAttribute("method"));
    const text = cleanText(`${form.text} ${form.toString()}`);
    if (!action || !looksLikeSaveConfigAction(action, text)) continue;
    const parsed = splitActionAndParams(action);
    const params = form.querySelectorAll("input,button").flatMap((input): Array<[string, string]> => {
      const name = input.getAttribute("name");
      if (!name || name === "token") return [];
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

export function describeWriteEndpoints(page: FormattedPage): Array<Record<string, unknown>> {
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

export function extractCandidatePaths(page: FormattedPage): string[] {
  const values = [
    ...page.frames.map((frame) => frame.src),
    ...page.links.map((link) => link.href),
    ...page.scripts.map((script) => script.src),
    ...page.forms.map((form) => (typeof form.action === "string" ? form.action : null)),
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

export function filterStatusCandidatePaths(paths: unknown[]): string[] {
  return [...new Set(
    paths
      .filter((path): path is string => typeof path === "string")
      .filter((path) => /\.(?:htm|html|js)$/i.test(path))
      .filter((path) => /mainrpm|statusrpm|sysstatus|systeminfo|product|top|menu|tab|frame|port/i.test(path)),
  )];
}

export function isMeaningfulPage(html: string, page: FormattedPage): boolean {
  if (looksLikeLoginPage(html)) return false;
  if (
    page.forms.length > 0 ||
    page.frames.length > 0 ||
    page.links.length > 0 ||
    page.scripts.length > 0 ||
    page.tables.length > 0
  ) {
    return true;
  }
  if (page.text.length < 30) return false;
  if (new RegExp(`^Copyright\\s*&copy;\\s*${VENDOR_COPYRIGHT_TEXT_PATTERN}$`, "i").test(page.text)) return false;
  return true;
}

export function looksLikeLoginPage(text: string): boolean {
  return /submitForm|plain_password|logonInfo\s*=\s*new Array\(\s*[1-9]/i.test(text);
}

export function extractToken(html: string): string | null {
  const patterns = [
    /(?:top\.)?g_tid\s*=\s*["']([^"']+)["']/i,
    /name=["']token["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']token["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

export function extractNumberVar(html: string, name: string): number | null {
  const match = html.match(new RegExp(`var\\s+${name}\\s*=\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : null;
}

export function extractLogonErrorCode(html: string): number | null {
  const match = html.match(/logonInfo\s*=\s*new Array\(\s*([\d-]+)/i);
  return match ? Number(match[1]) : null;
}

export function htmlToText(html: string): string {
  return formatHtmlPage(html).text;
}

export function extractJsObject(html: string, name: string): Record<string, unknown> | null {
  const startMatch = new RegExp(`var\\s+${name}\\s*=\\s*\\{`, "m").exec(html);
  if (!startMatch || startMatch.index === undefined) return null;

  const objectStart = html.indexOf("{", startMatch.index);
  const objectEnd = findMatchingBrace(html, objectStart);
  if (objectStart === -1 || objectEnd === -1) return null;

  const objectText = html.slice(objectStart, objectEnd + 1);
  const jsonText = objectText
    .replace(/\b0x([0-9a-fA-F]+)\b/g, (_, hex: string) => String(Number.parseInt(hex, 16)))
    .replace(/([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1")
    // Convert single-quoted JS strings to double-quoted JSON strings.
    // Unescape \' and escape any literal " so JSON.parse doesn't break.
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_, content: string) =>
      `"${content.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`,
    );

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
      if (depth === 0) return i;
    }
  }

  return -1;
}

function extractJsNumber(html: string, name: string): number | null {
  const match = html.match(new RegExp(`var\\s+${name}\\s*=\\s*"?(-?\\d+)"?`, "m"));
  return match ? Number(match[1]) : null;
}

function looksLikeSaveConfigAction(action: string, context: string): boolean {
  const text = `${action} ${context}`.toLowerCase();
  const hasSave = new RegExp(`save|${VENDOR_SAVE_TEXT}`).test(text);
  const hasConfig = new RegExp(`config|cfg|${VENDOR_CONFIG_TEXT}`).test(text);
  const risky = new RegExp(
    `backup|restore|reset|factory|reboot|upgrade|upload|import|${VENDOR_RISKY_TEXT_PATTERN}`,
  ).test(text);
  return hasSave && hasConfig && !risky;
}

export function splitActionAndParams(action: string): { action: string; params: Array<[string, string]> } {
  const normalized = action.replace(/^\//, "");
  const question = normalized.indexOf("?");
  if (question === -1) return { action: normalized, params: [] };

  const path = normalized.slice(0, question);
  const query = normalized.slice(question + 1);
  const params = [...new URLSearchParams(query).entries()].filter(
    ([key, value]) => key && value && !/top\.g_tid|g_tid/i.test(value),
  );

  return { action: path, params };
}

export function normalizeMethod(method: string | null | undefined): "GET" | "POST" {
  return method?.toUpperCase() === "POST" ? "POST" : "GET";
}

function cleanText(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
      const map: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      return map[char] ?? char;
    });
}
