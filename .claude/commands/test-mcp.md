Test the TP-Link Easy Smart Switch MCP server end-to-end.

Usage:
  /test-mcp                        — run get_switch_status against the default configured switch
  /test-mcp <tool>                 — run a specific tool (e.g. get_vlan_status)
  /test-mcp <tool> --host <ip>     — target a specific switch IP

## Steps

1. **Type-check** — run `bun run typecheck`. Stop and report if it fails.

2. **Resolve target** — parse $ARGUMENTS:
   - First non-flag word is the tool name (default: `get_switch_status`)
   - `--host <value>` overrides the switch IP
   - If no host, read `~/.config/tplink-mcp/switches.json` and show the default switch.
     If the file does not exist or is empty, remind the user to run `bun run tui` to add a switch.

3. **Run the debug script**:
   ```
   bun run scripts/debug-mcp.ts --tool <tool> [--host <ip>] [--username <u>] [--password <p>]
   ```
   Set `--host`, `--username`, `--password` from the resolved config or `--host` argument.
   Do NOT hard-code credentials; read them from the config file or environment variables.

4. **Report the result**:
   - On success: summarise the key fields returned (device model, port count, VLAN status, etc.)
   - On failure: show the raw error and suggest likely causes:
     - Switch not reachable → check IP, ping the host
     - Auth error → run `bun run tui` to update credentials
     - Type error → re-run `bun run typecheck` for details

## Available tools to test
- `get_switch_status`
- `get_port_status`
- `get_vlan_status`
- `get_trunk_status`
- `list_switches`
