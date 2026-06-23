import {
  VENDOR_APPLY_LABEL,
  VENDOR_DELETE_LABEL,
  VENDOR_ADD_EDIT_LABEL,
} from "./constants.js";
import { asNumber, asNumberArray, asString, uniqueNumbers, portsToBitmask, findParsedVlan, findParsedMembership } from "./utils.js";
import { maxInputPort } from "./utils.js";
import type { CgiRequestPlan, SaveConfigDiscovery } from "./types.js";

export function buildMtuVlanPlans(
  input: { enabled?: boolean; uplinkPort?: number },
  mtu: Record<string, unknown> | null,
  token: string | null,
): CgiRequestPlan[] {
  const tokenValue = token ?? "<top.g_tid>";
  const plans: CgiRequestPlan[] = [];

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

export function validateMtuVlanPlans(
  input: { enabled?: boolean; uplinkPort?: number },
  mtu: Record<string, unknown> | null,
  plans: CgiRequestPlan[],
): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const portCount = asNumber(mtu?.port_count);
  const currentEnabled = mtu?.enabled === true;

  if (plans.length === 0) errors.push("No MTU VLAN change was specified.");

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

  return { valid: errors.length === 0, errors, warnings };
}

export function buildPortVlanPlans(
  input: { enabled?: boolean; mode: "set" | "delete"; vid?: number; ports: number[] },
  portVlan: Record<string, unknown> | null,
  token: string | null,
): CgiRequestPlan[] {
  const tokenValue = token ?? "<top.g_tid>";
  const plans: CgiRequestPlan[] = [];

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
    const ports = uniqueNumbers(input.ports);
    plans.push({
      description: `Set port VLAN ${input.vid} member ports to ${ports.join(",")}`,
      action: "pvlanSet.cgi",
      method: "GET",
      referer: "VlanPortBasicRpm.htm",
      params: [
        ["vid", String(input.vid)],
        ...ports.map((port): [string, string] => ["selPorts", String(port)]),
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

export function validatePortVlanPlans(
  input: { enabled?: boolean; mode: "set" | "delete"; vid?: number; ports: number[] },
  portVlan: Record<string, unknown> | null,
  plans: CgiRequestPlan[],
): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const portCount = asNumber(portVlan?.port_count) ?? 0;
  const currentEnabled = portVlan?.enabled === true;
  const editRequested = input.vid !== undefined || input.ports.length > 0 || input.mode === "delete";
  const ports = uniqueNumbers(input.ports);

  if (!portVlan) warnings.push("Could not parse pvlan_ds from VlanPortBasicRpm.htm; validation is limited.");
  if (plans.length === 0) errors.push("No port VLAN change was specified.");
  if (input.mode === "delete" && input.vid === undefined) errors.push("delete mode requires vid.");
  if (input.mode === "set" && (input.vid !== undefined || input.ports.length > 0)) {
    if (input.vid === undefined) errors.push("set mode requires vid.");
    if (ports.length === 0) errors.push("set mode requires at least one member port.");
  }
  if (input.ports.length !== ports.length) errors.push("ports must not contain duplicates.");
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

  return { valid: errors.length === 0, errors, warnings };
}

export function build8021qVlanPlans(
  input: {
    enabled?: boolean;
    mode: "set" | "delete";
    vid?: number;
    name?: string;
    untaggedPorts: number[];
    taggedPorts: number[];
  },
  qvlan: Record<string, unknown> | null,
  token: string | null,
): CgiRequestPlan[] {
  const tokenValue = token ?? "<top.g_tid>";
  const plans: CgiRequestPlan[] = [];

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

export function validate8021qVlanPlans(
  input: {
    enabled?: boolean;
    mode: "set" | "delete";
    vid?: number;
    name?: string;
    untaggedPorts: number[];
    taggedPorts: number[];
  },
  qvlan: Record<string, unknown> | null,
  plans: CgiRequestPlan[],
): Record<string, unknown> {
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

  if (!qvlan) warnings.push("Could not parse qvlan_ds from Vlan8021QRpm.htm; validation is limited.");
  if (plans.length === 0) errors.push("No 802.1Q VLAN change was specified.");
  if (input.mode === "delete" && input.vid === undefined) errors.push("delete mode requires vid.");
  if (input.mode === "set" && editRequested) {
    if (input.vid === undefined) errors.push("set mode requires vid.");
    if (!suppliedPorts && existing) warnings.push("No tagged or untagged ports were specified; the current VLAN member ports will be reused.");
    if (!suppliedPorts && !existing) errors.push("New VLANs require taggedPorts or untaggedPorts.");
    if (members.length === 0) errors.push("802.1Q VLAN requires at least one tagged or untagged member port.");
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

  return { valid: errors.length === 0, errors, warnings };
}

export function buildPvidPlans(
  input: { pvid: number; ports: number[] },
  pvid: Record<string, unknown> | null,
  token: string | null,
): CgiRequestPlan[] {
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

export function validatePvidPlans(
  input: { pvid: number; ports: number[] },
  pvid: Record<string, unknown> | null,
  plans: CgiRequestPlan[],
): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const portCount = asNumber(pvid?.port_count) ?? 0;
  const ports = uniqueNumbers(input.ports);
  const vlanIds = asNumberArray(pvid?.vlan_ids);

  if (!pvid) warnings.push("Could not parse pvid_ds from Vlan8021QPvidRpm.htm; validation is limited.");
  if (plans.length === 0) errors.push("No PVID change was specified.");
  if (input.pvid < 1 || input.pvid > 4094) errors.push("PVID must be between 1 and 4094.");
  if (ports.length === 0) errors.push("At least one port is required.");
  if (ports.length !== input.ports.length) errors.push("ports must not contain duplicates.");
  for (const port of ports) {
    if (port < 1 || (portCount > 0 && port > portCount)) {
      errors.push(`Port ${port} is outside the allowed range 1-${portCount || "?"}.`);
    }
  }
  if (pvid?.enabled === false) errors.push("802.1Q VLAN is currently disabled; the Web UI script blocks setting PVID.");
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

  return { valid: errors.length === 0, errors, warnings };
}

export function buildSaveConfigurationPlans(discovery: SaveConfigDiscovery, token: string | null): CgiRequestPlan[] {
  const tokenValue = token ?? "<top.g_tid>";
  const params = discovery.params.filter(([key]) => key !== "token");

  return [{
    description: "Save the current running configuration to the device startup configuration",
    action: discovery.action,
    method: discovery.method,
    referer: "SavingConfigRpm.htm",
    params: [...params, ["token", tokenValue]],
    will_submit: false,
  }];
}

export function validateSaveConfigurationPlans(
  discovery: SaveConfigDiscovery,
  pageError: string | undefined,
  plans: CgiRequestPlan[],
): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const riskyPattern = /restore|reset|factory|reboot|upgrade|upload|import|backup|back/i;

  if (plans.length !== 1) errors.push("The save-configuration request plan is invalid.");
  if (!/savingconfig\.cgi$/i.test(discovery.action)) {
    errors.push(`The discovered save endpoint ${discovery.action} is not the savingconfig.cgi endpoint used by SavingConfigRpm.htm; refusing to submit.`);
  }
  if (!discovery.params.some(([key, value]) => key === "action_op" && value === "save")) {
    errors.push('The save-configuration request must include action_op: "save".');
  }
  if (riskyPattern.test(discovery.action)) {
    errors.push(`The discovered save endpoint ${discovery.action} does not look like a running-configuration save endpoint; refusing to submit.`);
  }
  if (pageError) warnings.push(`Failed to read SavingConfigRpm.htm: ${pageError}`);
  if (discovery.note) warnings.push(discovery.note);
  if (discovery.confidence !== "high") {
    warnings.push(`The save-configuration endpoint source is ${discovery.source}; compare the dry-run output with the page before submitting for real.`);
  }

  return { valid: errors.length === 0, errors, warnings, discovery };
}

export function buildTrunkPlans(
  input: { group: number; ports: number[]; mode: "set" | "delete" },
  trunk: Record<string, unknown> | null,
  token: string | null,
): CgiRequestPlan[] {
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

export function validateTrunkPlans(
  input: { group: number; ports: number[]; mode: "set" | "delete" },
  trunk: Record<string, unknown> | null,
): Record<string, unknown> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxGroups = asNumber(trunk?.max_groups) ?? 0;
  const portCount = asNumber(trunk?.port_count) ?? 0;
  const portsPerGroup = asNumber(trunk?.ports_per_group) ?? 4;

  if (!trunk) warnings.push("Could not parse trunk_conf from PortTrunkRpm.htm; validation is limited.");

  if (maxGroups > 0 && (input.group < 1 || input.group > maxGroups)) {
    errors.push(`group must be between 1 and ${maxGroups}.`);
  }

  if (input.mode === "delete") {
    return { valid: errors.length === 0, errors, warnings };
  }

  const uniquePorts = [...new Set(input.ports)];
  if (uniquePorts.length !== input.ports.length) errors.push("ports must not contain duplicates.");
  if (uniquePorts.length < 2) errors.push("The Web UI script requires at least 2 ports in a trunk group.");
  if (uniquePorts.length > portsPerGroup) {
    errors.push(`The Web UI script allows at most ${portsPerGroup} ports per trunk group.`);
  }
  for (const port of uniquePorts) {
    if (port < 1 || (portCount > 0 && port > portCount)) {
      errors.push(`Port ${port} is outside the allowed range 1-${portCount || "?"}.`);
    }
    if ((port <= 4 || port >= 9) && input.group === 2) errors.push("The Web UI script restricts LAG2 to ports 5 through 8.");
    if (port >= 5 && input.group === 1) errors.push("The Web UI script restricts LAG1 to ports 1 through 4.");
    if (port <= 8 && input.group === 3) errors.push("The Web UI script restricts LAG3 to ports 9 through 10.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function dryRunResult(
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

export function applyResult(
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

export function ensureWriteAllowed(
  confirm: string | undefined,
  validation: Record<string, unknown>,
  token: string | null,
  login: Record<string, unknown>,
): void {
  if (confirm !== "APPLY") throw new Error('Real writes require confirm: "APPLY".');
  if (login.success_hint !== true) throw new Error("Real writes require a successful login first.");
  if (validation.valid !== true) {
    throw new Error(`The request did not pass Web UI rule validation: ${JSON.stringify(validation)}`);
  }
  if (!token) throw new Error("Could not read top.g_tid/token from the page; refusing to submit a real write.");
}

export function summarizeLogin(login: Record<string, unknown>): Record<string, unknown> {
  return {
    attempted: login.attempted,
    success: login.success_hint ?? false,
    status: login.status,
    error_code: login.error_code,
    cookies_saved: login.cookies_saved,
    message: login.message,
  };
}

export function buildStatusResponse(input: {
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
  const source = { path: input.page.path ?? null, status: input.page.status ?? null };

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
    base.debug = { login: input.login, page: input.page };
  }

  return base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
