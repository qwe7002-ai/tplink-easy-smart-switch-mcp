Manage a TP-Link / Mercury Easy Smart switch via MCP tools.

Usage:
  /switch <natural-language task>

Examples:
  /switch show me the current VLAN configuration
  /switch create VLAN 20 named "IoT" with ports 3 and 4 untagged, port 1 tagged
  /switch set port 5 PVID to 20
  /switch delete VLAN 30
  /switch save configuration

## Workflow

Always follow Read → Plan → Dry-run → Apply. Never submit a write operation
without first running a dry-run and summarising what will change.

### 1. Read current state

Call the appropriate read tool(s) based on the task:

| Task involves | Call |
|---|---|
| Port link status, device model | `get_switch_status` |
| Port speed / duplex / flow control | `get_port_status` |
| Any VLAN operation | `get_vlan_status` |
| Trunk / LAG groups | `get_trunk_status` |
| List managed switches | `list_switches` |

For VLAN tasks always call `get_vlan_status` even if the task seems narrow —
you need the full current config to build a correct plan.

### 2. Plan

Based on the current state and the user's request, identify:
- Which tool(s) will be called
- Which parameters will change vs stay the same
- Whether any dependency order matters (e.g. set PVID before deleting VLAN)
- Whether a save is needed at the end

Summarise the plan in bullet points before proceeding.

### 3. Dry-run

Call each write tool with `apply: false` (omit `confirm`).
The tool returns a description of what it *would* do — show this to the user.

```json
{ "apply": false, ... }
```

If the dry-run reveals an error or unexpected behaviour, stop and ask.

### 4. Apply

Only apply after the dry-run looks correct. Call the same tool(s) again with:

```json
{ "apply": true, "confirm": "APPLY", ... }
```

After every successful apply, offer to call `save_configuration` unless the
user said not to persist the change.

---

## Available write tools and their key parameters

### `configure_8021q_vlan`
Enable/disable 802.1Q, create/update/delete VLANs.

```
action: "enable" | "disable" | "set" | "delete"
vid: number           // VLAN ID (1–4094)
name: string          // VLAN name (set only)
ports: {              // port membership (set only)
  [portNumber]: "untagged" | "tagged" | "not_member"
}
apply: boolean
confirm: "APPLY"      // required when apply: true
```

### `configure_vlan_pvid`
Set per-port PVID (native VLAN for untagged ingress traffic).

```
pvid: number          // VLAN ID to assign
ports: number[]       // port numbers to apply to
apply: boolean
confirm: "APPLY"
```

### `configure_port_vlan`
Manage port-based (non-802.1Q) VLAN mode.

```
action: "enable" | "disable" | "set" | "delete"
vid: number
ports: number[]
apply: boolean
confirm: "APPLY"
```

### `configure_mtu_vlan`
Configure MTU VLAN (uplink-based) mode.

```
action: "enable" | "disable" | "set_uplink"
uplinkPort: number    // set_uplink only
apply: boolean
confirm: "APPLY"
```

### `configure_trunk_group`
Create or delete a trunk (LAG) group.

```
action: "set" | "delete"
groupId: number       // 1–4 typically
ports: number[]       // member ports (set only)
apply: boolean
confirm: "APPLY"
```

### `save_configuration`
Persist current config to flash (survives reboot).

```
apply: boolean
confirm: "APPLY"
```

---

## Common recipes

### Create a new tagged VLAN with an untagged access port

1. `get_vlan_status` — verify 802.1Q is enabled and VLAN ID is free
2. Dry-run `configure_8021q_vlan` action=set with the desired membership
3. Apply `configure_8021q_vlan`
4. Dry-run `configure_vlan_pvid` to set the PVID on the untagged port
5. Apply `configure_vlan_pvid`
6. Apply `save_configuration`

### Delete a VLAN safely

1. `get_vlan_status` — check no port has this VLAN as its PVID
2. If any port's PVID matches, change those PVIDs first (usually to VLAN 1)
3. Dry-run then apply `configure_8021q_vlan` action=delete

### Trunk two ports together

1. `get_trunk_status` — find a free group ID
2. Dry-run then apply `configure_trunk_group` action=set
3. Apply `save_configuration`

---

## Host selection

If the user specifies a host, pass `host` to every tool call. Otherwise omit
it and the MCP server uses the configured default switch.

To see available switches: `list_switches`.

---

## Safety rules

- Never skip the dry-run step.
- Never pass `confirm: "APPLY"` before reviewing the dry-run output.
- Always check that the PVID of a port is not set to a VLAN you're about to delete.
- Warn the user if 802.1Q is disabled when they ask for 802.1Q VLAN operations.
- Remind the user to call `save_configuration` after write operations if they want changes to survive a reboot.
