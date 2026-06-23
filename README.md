# TP-Link Easy Smart Switch MCP

TypeScript + Bun MCP server for TP-Link and Mercury Easy Smart switches. It works through the switch Web UI and does not depend on SNMP.

Default target: `http://192.168.3.10`

## Tested Models

The current implementation has been tested against these Web UI snapshots and read-only status calls:

- TP-Link TL-SE2106 at `192.168.3.10`, firmware `1.8.1 Build 20251128 Rel.57341`
- Mercury SE106 Pro at `192.168.3.11`, firmware `1.0.0 Build 20240812 Rel.65021`

Other TP-Link or Mercury Easy Smart switches may work if they use the same Web UI pages and CGI endpoints, but they have not been verified yet.

## Confirmed Device Traits

- Management UI is available on HTTP `80`
- Login form posts to `POST /logon.cgi`
- Login fields are `username` and encrypted `password`
- Login page loads `/cryp_new.js`
- Known Web UI variables include `g_product`, `g_year`, and `encryptType`

## Tools

Read-only tools:

- `get_switch_status`: Return a switch status summary
- `get_port_status`: Return port status
- `get_vlan_status`: Return port VLAN, 802.1Q VLAN, PVID, and MTU VLAN status
- `get_trunk_status`: Return port trunking/LAG status

Configuration CGI tools:

- `configure_mtu_vlan`: Generate or submit `mtuVlanSet.cgi` from `VlanMtuRpm.htm`
- `configure_port_vlan`: Generate or submit `pvlanSet.cgi` from `VlanPortBasicRpm.htm`
- `configure_8021q_vlan`: Generate or submit `qvlanSet.cgi` from `Vlan8021QRpm.htm`
- `configure_vlan_pvid`: Generate or submit `vlanPvidSet.cgi` from `Vlan8021QPvidRpm.htm`
- `configure_trunk_group`: Generate or submit `port_trunk_set.cgi` / `port_trunk_display.cgi` from `PortTrunkRpm.htm`
- `save_configuration`: Generate or submit `POST savingconfig.cgi` from `SavingConfigRpm.htm`

Configuration tools default to `apply: false`, which returns a dry-run request preview and submits nothing. Real writes require all of the following:

- `apply: true`
- `confirm: "APPLY"`
- Successful login
- Web UI rule validation passed
- A readable `token/top.g_tid`

## Install

```powershell
bun install
```

## Run During Development

```powershell
bun run src/index.ts
```

## Build A Binary

Windows:

```powershell
bun run build:win
```

Current platform:

```powershell
bun run build
```

Build output is written to `dist/`.

If an MCP client still reports an older server version during `initialize`, its `command` probably points to an old executable. Update it to `dist/tplink-easy-smart-switch-mcp.exe` and restart the client.

## Debug MCP

List MCP tools:

```powershell
bun run debug
```

Call the switch status tool:

```powershell
bun run debug -- --tool get_switch_status --host 192.168.3.10 --username admin --password your-password
bun run debug -- --tool get_switch_status --host 192.168.3.11
```

Call the port status tool:

```powershell
bun run debug -- --tool get_port_status --host 192.168.3.10 --username admin --password your-password
```

Preview configuration requests without submitting them:

```powershell
bun run debug -- --tool configure_mtu_vlan --params '{ "enabled": true }'
bun run debug -- --tool configure_port_vlan --params '{ "mode": "set", "vid": 1, "ports": "1,2" }'
bun run debug -- --tool configure_8021q_vlan --params '{ "mode": "set", "vid": 20, "name": "main", "untaggedPorts": "3", "taggedPorts": "5,6" }'
bun run debug -- --tool configure_vlan_pvid --params '{ "pvid": 20, "ports": "3" }'
bun run debug -- --tool configure_trunk_group --params '{ "mode": "set", "group": 1, "ports": "1,2" }'
bun run debug -- --tool save_configuration --params '{}'
```

## Page Samples

Read-only development snapshots are stored in:

- `examples/tplink-192.168.3.10`: TP-Link Easy Smart switch at `192.168.3.10`
- `examples/mercury-192.168.3.11`: Mercury SE106 Pro at `192.168.3.11`

They include VLAN, trunking, configuration backup/restore, save-configuration pages, plus `pvlan.js`, `qvlan.js`, and `menuList.js`. These samples do not contain SessionID values or passwords.

You can also send raw JSON-RPC:

```powershell
bun run debug -- --raw '{ "jsonrpc": "2.0", "id": 99, "method": "tools/list", "params": {} }'
```

## MCP Client Example

```json
{
  "mcpServers": {
    "tplink-easy-smart-switch": {
      "command": "C:\\path\\to\\tplink-easy-smart-switch-mcp.exe",
      "env": {
        "TPLINK_HOST": "192.168.3.10",
        "TPLINK_USERNAME": "admin",
        "TPLINK_PASSWORD": "your-password"
      }
    }
  }
}
```

## Notes

Page content is parsed with a DOM parser and normalized into title, form, frame, link, table, and text summaries. Status data is mainly extracted from JavaScript variables in pages such as `MainRpm.htm`, `VlanPortBasicRpm.htm`, `Vlan8021QRpm.htm`, `Vlan8021QPvidRpm.htm`, `VlanMtuRpm.htm`, and `PortTrunkRpm.htm`.

Configuration CGI calls use an explicit confirmation flow. Development and debugging default to dry-run. `save_configuration` is also a write action; it follows the page logic from `SavingConfigRpm.htm` and uses `POST savingconfig.cgi`, but it does not submit unless explicitly confirmed.
