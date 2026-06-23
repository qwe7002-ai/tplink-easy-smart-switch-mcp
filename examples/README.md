# Web UI Snapshots

Read-only HTML snapshots of real TP-Link and Mercury Easy Smart switches,
used to develop and verify the page parsers and CGI request builders.

## Captured devices

| Directory | Model | Firmware |
|---|---|---|
| `tplink-192.168.3.10/` | TL-SE2106 | 1.8.1 Build 20251128 |
| `mercury-192.168.3.11/` | Mercury Easy Smart | — |

## What is captured

Each directory contains:

| File | Switch path | Purpose |
|---|---|---|
| `MainRpm.htm` | `/MainRpm.htm` | Device info, port state, VLAN summary (`info_ds`, `port_info`, `qvlan_ds`) |
| `Menu.htm` | `/Menu.htm` | Token source (`g_tid`) |
| `VlanPortBasicRpm.htm` | `/VlanPortBasicRpm.htm` | Port VLAN config (`pvlan_ds`) |
| `Vlan8021QRpm.htm` | `/Vlan8021QRpm.htm` | 802.1Q VLAN config (`qvlan_ds`) |
| `Vlan8021QPvidRpm.htm` | `/Vlan8021QPvidRpm.htm` | PVID config (`pvid_ds`) |
| `VlanMtuRpm.htm` | `/VlanMtuRpm.htm` | MTU VLAN config (`mtu_ds`) |
| `PortTrunkRpm.htm` | `/PortTrunkRpm.htm` | Trunk/LAG config (`trunk_conf`) |
| `SavingConfigRpm.htm` | `/SavingConfigRpm.htm` | Save-config form discovery |
| `ConfigRpm.htm` | `/ConfigRpm.htm` | Backup/restore page (reference only) |
| `assets/menuList.js` | `/menuList.js` | Menu structure |
| `assets/pvlan.js` | `/pvlan.js` | Port VLAN JS logic |
| `assets/qvlan.js` | `/qvlan.js` | 802.1Q VLAN JS logic |
| `manifest.json` | — | Fetch metadata (timestamp, HTTP status) |

No cookies, session IDs, or passwords are stored.
Token values in the HTML are replaced with `<redacted>`.

## Capture your own switch

```sh
bun run capture -- --host 192.168.1.10 --username admin --password secret
```

Output goes to `examples/192.168.1.10/`.

```sh
# Extra options
bun run capture -- --host 192.168.1.10 --out /tmp/my-captures
```

See `scripts/capture.ts` for full option reference.

## CGI endpoints (write operations)

These are the CGI paths the MCP tools submit to. They are **not** captured here
(write operations are only executed when `apply: true, confirm: "APPLY"` are set),
but they are documented for reference.

| Tool | CGI path | Method | Key params |
|---|---|---|---|
| `configure_mtu_vlan` (enable/disable) | `mtuVlanSet.cgi` | GET | `mtu_en`, `mtu_mode`, `token` |
| `configure_mtu_vlan` (uplink port) | `mtuVlanSet.cgi` | GET | `uplinkPort`, `mtu_uplink`, `token` |
| `configure_port_vlan` (enable/disable) | `pvlanSet.cgi` | GET | `pvlan_en`, `pvlan_mode`, `token` |
| `configure_port_vlan` (set) | `pvlanSet.cgi` | GET | `vid`, `selPorts`, `pvlan_add`, `token` |
| `configure_port_vlan` (delete) | `pvlanSet.cgi` | GET | `selVlans`, `pvlan_del`, `token` |
| `configure_8021q_vlan` (enable/disable) | `qvlanSet.cgi` | GET | `qvlan_en`, `qvlan_mode`, `token` |
| `configure_8021q_vlan` (set) | `qvlanSet.cgi` | GET | `vid`, `vname`, `selType_N`, `qvlan_add`, `token` |
| `configure_8021q_vlan` (delete) | `qvlanSet.cgi` | GET | `selVlans`, `qvlan_del`, `token` |
| `configure_vlan_pvid` | `vlanPvidSet.cgi` | GET | `pbm` (bitmask), `pvid`, `token` |
| `configure_trunk_group` (set) | `port_trunk_set.cgi` | GET | `groupId`, `portid` (repeated), `setapply`, `token` |
| `configure_trunk_group` (delete) | `port_trunk_display.cgi` | GET | `chk_trunk`, `setDelete`, `token` |
| `save_configuration` | `savingconfig.cgi` | POST | `action_op=save`, `token` |

`selType_N` values for 802.1Q VLAN: `0` = untagged, `1` = tagged, `2` = not member.
`pbm` for PVID is a 32-bit little-endian bitmask: port 1 = bit 0 (`1`), port 2 = bit 1 (`2`), etc.
