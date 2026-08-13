---
name: manage-tplink-easy-smart-switches
description: Inspect and safely configure TP-Link or Mercury Easy Smart switches with the tplink-easy-smart-switch-mcp tools. Use for switch and port status, VLAN or PVID review, trunks and LAGs, MAC address location, multi-switch topology analysis, guarded configuration changes, or saving switch configuration.
---

# Manage TP-Link Easy Smart Switches

Use the TP-Link Easy Smart Switch MCP server for device operations. Treat switch credentials and network configuration as sensitive.

## Workflow

1. Select the target by configured switch name or explicit host. Use `list_switches` when the target is unclear.
2. Read the current state before proposing a change. Collect the relevant device, port, VLAN, PVID, trunk, MAC, or topology facts.
3. Explain the intended change, affected ports and VLANs, management-access risk, and rollback approach.
4. Call configuration tools with `apply: false` first and inspect the generated request preview.
5. Make a live change only when the current request clearly authorizes that exact change. Set `apply: true` and `confirm: "APPLY"`.
6. Read the affected state again after a write. Call `save_configuration` only when persistence was requested or explicitly approved.

## Choose the Correct Tool

- Use `get_switch_status` for model, firmware, management identity, and general health.
- Use `get_port_status` for link state, speed, and port activity.
- Use `get_vlan_status` for port VLAN, 802.1Q VLAN, PVID, and MTU VLAN state.
- Use `get_trunk_status` for trunk or LAG membership.
- Use `search_mac_address` to locate one learned MAC address and its VLAN or port.
- Use `analyze_topology` for two or more cascaded configured switches. Treat fallback SFP/10G inference as low-confidence evidence.
- Use the matching `configure_*` tool for MTU VLAN, port VLAN, 802.1Q VLAN, PVID, or trunk changes.
- Use `save_configuration` separately after verification when changes must survive reboot.

## Safety Rules

- Never echo passwords, include them in summaries, write them to project files, or send them to web searches or unrelated tools.
- Prefer a configured switch name or environment-based credentials over placing passwords in conversation. The local switch configuration may contain plaintext credentials, so keep its filesystem permissions restricted.
- The tested switch Web UIs use HTTP. Operate only on a trusted management network and warn that credentials are not transport-encrypted.
- Do not change an uplink, management VLAN, PVID, or tagged/untagged membership until the current management path is identified.
- Do not infer port numbers, VLAN IDs, or trunk membership. Read them from the device or ask the user.
- Keep dry-run previews free of secrets when presenting them to the user.
- If verification fails or management access may be lost, stop further writes and report the last confirmed state.

## Reporting

Separate observed device facts from inferred topology. For writes, report the preview, authorization basis, submitted change, verification result, and whether configuration was saved.
