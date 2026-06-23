import { normalizeMac } from "./parsers.js";
import type { MacTableResult } from "./parsers.js";

export interface SwitchVlan {
  vid: number;
  name: string;
  tagged_ports: number[];
  untagged_ports: number[];
  member_ports: number[];
}

export interface SwitchFacts {
  target: string;
  ok: boolean;
  error?: string;
  identity: {
    mac: string | null;
    ip: string | null;
    gateway: string | null;
    model: string | null;
    description: string | null;
  };
  ports: Array<{ port: number; link_up: boolean; type: string; speed_code: number | null; rx_mbps: number | null; tx_mbps: number | null }>;
  qvlan_enabled: boolean | null;
  vlans: SwitchVlan[];
  pvids: Array<{ port: number; pvid: number | null }>;
  mac_table: MacTableResult;
  login: { attempted: unknown; success: unknown };
}

interface Endpoint {
  target: string;
  model: string | null;
  port: number | null;
  port_type: string | null;
  learned_mac_count: number;
  foreign_mac_count: number;
}

function distinctPortsForMac(facts: SwitchFacts, mac: string | null): number[] {
  if (!mac) return [];
  const ports = new Set<number>();
  for (const entry of facts.mac_table.entries) {
    if (entry.mac === mac && typeof entry.port === "number") ports.add(entry.port);
  }
  return [...ports].sort((a, b) => a - b);
}

function macsOnPort(facts: SwitchFacts, port: number): Set<string> {
  const macs = new Set<string>();
  for (const entry of facts.mac_table.entries) {
    if (entry.port === port) macs.add(entry.mac);
  }
  return macs;
}

function portType(facts: SwitchFacts, port: number | null): string | null {
  if (port === null) return null;
  return facts.ports.find((p) => p.port === port)?.type ?? null;
}

function portTrafficScore(port: SwitchFacts["ports"][number]): number {
  return (port.rx_mbps ?? 0) + (port.tx_mbps ?? 0);
}

function activeSfpPorts(facts: SwitchFacts): SwitchFacts["ports"] {
  return facts.ports.filter((p) => p.link_up && p.type === "sfp");
}

function vlanPairScore(a: SwitchFacts, aPort: number, b: SwitchFacts, bPort: number): number {
  const roleA = vlanRoleOnPort(a, aPort);
  const roleB = vlanRoleOnPort(b, bPort);
  const membersA = new Set([...roleA.tagged, ...roleA.untagged]);
  const membersB = new Set([...roleB.tagged, ...roleB.untagged]);
  const matched = [...membersA].filter((vid) => membersB.has(vid));
  let sameMode = 0;
  let modeMismatch = 0;

  for (const vid of matched) {
    const aTagged = roleA.tagged.includes(vid);
    const bTagged = roleB.tagged.includes(vid);
    if (aTagged === bTagged) sameMode += 1;
    else modeMismatch += 1;
  }

  const pvidMatch = roleA.pvid !== null && roleA.pvid === roleB.pvid ? 1 : 0;
  return matched.length * 10 + sameMode * 3 + pvidMatch * 5 - modeMismatch * 4;
}

function pickSfpFallbackPair(a: SwitchFacts, b: SwitchFacts): { aPort: number; bPort: number } | null {
  const aCandidates = activeSfpPorts(a);
  const bCandidates = activeSfpPorts(b);
  if (aCandidates.length === 0 || bCandidates.length === 0) return null;

  const ranked = [];
  for (const aPort of aCandidates) {
    for (const bPort of bCandidates) {
      ranked.push({
        aPort: aPort.port,
        bPort: bPort.port,
        vlanScore: vlanPairScore(a, aPort.port, b, bPort.port),
        trafficScore: portTrafficScore(aPort) + portTrafficScore(bPort),
      });
    }
  }
  ranked.sort((x, y) => y.vlanScore - x.vlanScore || y.trafficScore - x.trafficScore);
  if (ranked.length === 0) return null;
  if (
    ranked.length > 1 &&
    ranked[0]!.vlanScore === ranked[1]!.vlanScore &&
    ranked[0]!.trafficScore === ranked[1]!.trafficScore
  ) {
    return null;
  }
  return { aPort: ranked[0]!.aPort, bPort: ranked[0]!.bPort };
}

function vlanRoleOnPort(facts: SwitchFacts, port: number | null) {
  const tagged: number[] = [];
  const untagged: number[] = [];
  if (port !== null) {
    for (const vlan of facts.vlans) {
      if (vlan.tagged_ports.includes(port)) tagged.push(vlan.vid);
      else if (vlan.untagged_ports.includes(port)) untagged.push(vlan.vid);
    }
  }
  const pvid = port === null ? null : facts.pvids.find((p) => p.port === port)?.pvid ?? null;
  return { tagged: tagged.sort((a, b) => a - b), untagged: untagged.sort((a, b) => a - b), pvid };
}

function buildEndpoint(facts: SwitchFacts, port: number | null, peerMac: string | null, selfMac: string | null): Endpoint {
  const macs = port === null ? new Set<string>() : macsOnPort(facts, port);
  const foreign = new Set(macs);
  if (peerMac) foreign.delete(peerMac);
  if (selfMac) foreign.delete(selfMac);
  return {
    target: facts.target,
    model: facts.identity.model,
    port,
    port_type: portType(facts, port),
    learned_mac_count: macs.size,
    foreign_mac_count: foreign.size,
  };
}

function analyzeLinkVlans(a: SwitchFacts, aPort: number | null, b: SwitchFacts, bPort: number | null) {
  const roleA = vlanRoleOnPort(a, aPort);
  const roleB = vlanRoleOnPort(b, bPort);
  const membersA = new Set([...roleA.tagged, ...roleA.untagged]);
  const membersB = new Set([...roleB.tagged, ...roleB.untagged]);
  const matched = [...membersA].filter((vid) => membersB.has(vid)).sort((x, y) => x - y);
  const only_a = [...membersA].filter((vid) => !membersB.has(vid)).sort((x, y) => x - y);
  const only_b = [...membersB].filter((vid) => !membersA.has(vid)).sort((x, y) => x - y);

  const warnings: string[] = [];
  for (const vid of matched) {
    const aTagged = roleA.tagged.includes(vid);
    const bTagged = roleB.tagged.includes(vid);
    if (aTagged !== bTagged) {
      warnings.push(`VLAN ${vid} is ${aTagged ? "tagged" : "untagged"} on ${a.target} port ${aPort} but ${bTagged ? "tagged" : "untagged"} on ${b.target} port ${bPort}; traffic for this VLAN will not pass cleanly.`);
    }
  }
  if (roleA.pvid !== null && roleB.pvid !== null && roleA.pvid !== roleB.pvid) {
    warnings.push(`Native/PVID differs across the link: ${a.target} port ${aPort} PVID ${roleA.pvid} vs ${b.target} port ${bPort} PVID ${roleB.pvid}. Untagged traffic may land in different VLANs.`);
  }
  for (const vid of only_a) {
    warnings.push(`VLAN ${vid} is carried on ${a.target} port ${aPort} but not on ${b.target} port ${bPort}; it will not reach the other switch.`);
  }
  for (const vid of only_b) {
    warnings.push(`VLAN ${vid} is carried on ${b.target} port ${bPort} but not on ${a.target} port ${aPort}; it will not reach the other switch.`);
  }

  const taggedBoth = matched.filter((vid) => roleA.tagged.includes(vid) && roleB.tagged.includes(vid));
  const link_type = taggedBoth.length >= 1
    ? "trunk"
    : matched.length === 1
      ? "access"
      : "undetermined";

  return {
    link_type,
    side_a: { target: a.target, port: aPort, ...roleA },
    side_b: { target: b.target, port: bPort, ...roleB },
    matched_vlans: matched,
    only_on_a: only_a,
    only_on_b: only_b,
    consistent: warnings.length === 0,
    warnings,
  };
}

function inferHierarchy(endpointA: Endpoint, endpointB: Endpoint) {
  // The downstream switch reaches the rest of the network (gateway, uplink,
  // everything beyond) through this link, so its link port has learned more
  // foreign MAC addresses than the upstream switch's link port.
  const a = endpointA.foreign_mac_count;
  const b = endpointB.foreign_mac_count;
      if (a === 0 && b === 0) {
    return {
      determined: false,
      reason: "Neither link port has learned foreign MAC addresses (idle link or empty MAC evidence); cannot infer direction.",
    };
  }
  if (a === b) {
    return {
      determined: false,
      reason: "Both link ports have learned the same number of foreign MAC addresses; direction is ambiguous.",
    };
  }
  const downstream = a > b ? endpointA : endpointB;
  const upstream = a > b ? endpointB : endpointA;
  const ratio = Math.max(a, b) / Math.max(1, Math.min(a, b));
  return {
    determined: true,
    upstream: { target: upstream.target, model: upstream.model, port: upstream.port },
    downstream: { target: downstream.target, model: downstream.model, port: downstream.port },
    basis: "Compared the number of foreign MAC addresses learned on each side's link port; the side that sees more of the network is downstream.",
    confidence: ratio >= 2 ? "medium" : "low",
  };
}

export function analyzeTopology(facts: SwitchFacts[]): Record<string, unknown> {
  const notes: string[] = [];
  const links: Array<Record<string, unknown>> = [];

  for (let i = 0; i < facts.length; i += 1) {
    for (let j = i + 1; j < facts.length; j += 1) {
      const a = facts[i]!;
      const b = facts[j]!;
      const aMac = normalizeMac(a.identity.mac);
      const bMac = normalizeMac(b.identity.mac);

      const aSeesB = distinctPortsForMac(a, bMac);
      const bSeesA = distinctPortsForMac(b, aMac);

      let aPort: number | null = null;
      let bPort: number | null = null;
      let method = "";
      let confidence = "low";

      if (aSeesB.length > 0 && bSeesA.length > 0) {
        // Strongest evidence: each switch has learned the other's management MAC.
        aPort = aSeesB[0]!;
        bPort = bSeesA[0]!;
        method = "mac-table: each switch learned the other's management MAC on this port";
        confidence = aSeesB.length === 1 && bSeesA.length === 1 ? "high" : "medium";
      } else {
        // Fallback: pick the single up SFP port on each side as a candidate link
        // (Easy Smart cascades over the 10G SFP port, and these L2 switches have
        // no LLDP). This is a guess, not a confirmed adjacency.
        const fallback = pickSfpFallbackPair(a, b);
        if (fallback) {
          aPort = fallback.aPort;
          bPort = fallback.bPort;
          method = "inferred: selected active SFP/10G port pair, preferring VLAN overlap and using traffic as a tiebreaker (MAC search did not confirm adjacency)";
          confidence = "low";
        }
      }

      if (aPort === null || bPort === null) {
        notes.push(`Could not determine a link between ${a.target} and ${b.target}. ${!a.mac_table.readable || !b.mac_table.readable ? "At least one MAC evidence source was not readable. " : ""}Verify both switches are logged in and physically connected.`);
        continue;
      }

      const endpointA = buildEndpoint(a, aPort, bMac, aMac);
      const endpointB = buildEndpoint(b, bPort, aMac, bMac);
      const hierarchy = inferHierarchy(endpointA, endpointB);
      const vlan = analyzeLinkVlans(a, aPort, b, bPort);

      links.push({
        endpoints: [endpointA, endpointB],
        detection: { method, confidence },
        hierarchy,
        vlan,
      });
    }
  }

  // Cross-switch VLAN overview, independent of the physical link.
  const vlanSets = facts.map((f) => ({ target: f.target, vids: f.vlans.map((v) => v.vid).sort((a, b) => a - b) }));
  const allVids = new Set<number>();
  vlanSets.forEach((s) => s.vids.forEach((v) => allVids.add(v)));
  const common = [...allVids].filter((vid) => vlanSets.every((s) => s.vids.includes(vid))).sort((a, b) => a - b);

  return {
    switches: facts.map((f) => ({
      target: f.target,
      model: f.identity.model,
      description: f.identity.description,
      mac: normalizeMac(f.identity.mac),
      ip: f.identity.ip,
      gateway: f.identity.gateway,
      qvlan_enabled: f.qvlan_enabled,
      mac_evidence_readable: f.mac_table.readable,
      mac_evidence_entries: f.mac_table.count,
      login_success: f.login.success,
      reachable: f.ok,
      ...(f.error ? { error: f.error } : {}),
    })),
    links,
    vlan_overview: {
      per_switch: vlanSets,
      common_vlans: common,
    },
    notes,
  };
}
