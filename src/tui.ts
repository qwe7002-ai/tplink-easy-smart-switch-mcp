#!/usr/bin/env bun
import * as readline from "node:readline";
import { loadConfig, saveConfig, CONFIG_PATH } from "./config.js";
import { tcpOpen } from "./http.js";
import type { SwitchEntry } from "./types.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

function clear() {
  process.stdout.write("\x1Bc");
}

function printHeader() {
  console.log("TP-Link Easy Smart Switch Manager");
  console.log("==================================");
  console.log(`Config: ${CONFIG_PATH}\n`);
}

function printSwitches(switches: SwitchEntry[], defaultName?: string) {
  if (switches.length === 0) {
    console.log("  (no switches configured)\n");
    return;
  }
  switches.forEach((sw, i) => {
    const marker = sw.name === defaultName ? " [default]" : "";
    const creds = sw.username ? ` (user: ${sw.username})` : "";
    console.log(`  ${i + 1}. ${sw.name}  ${sw.host}${creds}${marker}`);
  });
  console.log();
}

async function addSwitch() {
  console.log("\n-- Add Switch --");
  const host = await ask("Host (IP or hostname): ");
  if (!host) { console.log("Cancelled."); return; }

  const name = await ask(`Name [${host}]: `) || host;
  const username = await ask("Username (leave blank to skip): ");
  const password = username ? await ask("Password: ") : undefined;

  const entry: SwitchEntry = { name, host };
  if (username) entry.username = username;
  if (password) entry.password = password;

  const config = loadConfig();
  const existing = config.switches.findIndex((s) => s.name === name);
  if (existing >= 0) {
    const overwrite = await ask(`Switch "${name}" already exists. Overwrite? [y/N]: `);
    if (overwrite.toLowerCase() !== "y") { console.log("Cancelled."); return; }
    config.switches[existing] = entry;
  } else {
    config.switches.push(entry);
    if (config.switches.length === 1) config.default = name;
  }

  saveConfig(config);
  console.log(`\nSaved "${name}" (${host}).`);
}

async function removeSwitch() {
  const config = loadConfig();
  if (config.switches.length === 0) { console.log("\nNo switches to remove."); return; }

  console.log("\n-- Remove Switch --");
  printSwitches(config.switches, config.default);
  const input = await ask("Enter number or name to remove (blank to cancel): ");
  if (!input) { console.log("Cancelled."); return; }

  const index = /^\d+$/.test(input)
    ? Number(input) - 1
    : config.switches.findIndex((s) => s.name === input);

  if (index < 0 || index >= config.switches.length) {
    console.log("Not found.");
    return;
  }

  const removed = config.switches.splice(index, 1)[0];
  if (config.default === removed.name) {
    config.default = config.switches[0]?.name;
  }

  saveConfig(config);
  console.log(`\nRemoved "${removed.name}".`);
}

async function setDefault() {
  const config = loadConfig();
  if (config.switches.length === 0) { console.log("\nNo switches configured."); return; }

  console.log("\n-- Set Default Switch --");
  printSwitches(config.switches, config.default);
  const input = await ask("Enter number or name (blank to cancel): ");
  if (!input) { console.log("Cancelled."); return; }

  const index = /^\d+$/.test(input)
    ? Number(input) - 1
    : config.switches.findIndex((s) => s.name === input);

  if (index < 0 || index >= config.switches.length) {
    console.log("Not found.");
    return;
  }

  config.default = config.switches[index].name;
  saveConfig(config);
  console.log(`\nDefault set to "${config.default}".`);
}

async function testConnection() {
  const config = loadConfig();
  if (config.switches.length === 0) { console.log("\nNo switches configured."); return; }

  console.log("\n-- Test Connection --");
  printSwitches(config.switches, config.default);
  const input = await ask("Enter number or name (blank to test all): ");

  const targets = !input
    ? config.switches
    : (() => {
        const index = /^\d+$/.test(input)
          ? Number(input) - 1
          : config.switches.findIndex((s) => s.name === input);
        return index >= 0 ? [config.switches[index]] : [];
      })();

  if (targets.length === 0) { console.log("Not found."); return; }

  console.log();
  for (const sw of targets) {
    process.stdout.write(`  ${sw.name} (${sw.host}:80) ... `);
    const open = await tcpOpen(sw.host, 80);
    console.log(open ? "REACHABLE" : "UNREACHABLE");
  }
  console.log();
}

async function editSwitch() {
  const config = loadConfig();
  if (config.switches.length === 0) { console.log("\nNo switches configured."); return; }

  console.log("\n-- Edit Switch --");
  printSwitches(config.switches, config.default);
  const input = await ask("Enter number or name (blank to cancel): ");
  if (!input) { console.log("Cancelled."); return; }

  const index = /^\d+$/.test(input)
    ? Number(input) - 1
    : config.switches.findIndex((s) => s.name === input);

  if (index < 0 || index >= config.switches.length) {
    console.log("Not found.");
    return;
  }

  const sw = config.switches[index];
  console.log(`\nEditing "${sw.name}" — press Enter to keep current value.\n`);

  const newName = await ask(`Name [${sw.name}]: `) || sw.name;
  const newHost = await ask(`Host [${sw.host}]: `) || sw.host;
  const newUsername = await ask(`Username [${sw.username ?? ""}]: `);
  const resolvedUsername = newUsername || sw.username;
  let newPassword = sw.password;
  if (resolvedUsername) {
    const changePw = await ask("Change password? [y/N]: ");
    if (changePw.toLowerCase() === "y") {
      newPassword = await ask("New password: ") || sw.password;
    }
  }

  const updated: SwitchEntry = { name: newName, host: newHost };
  if (resolvedUsername) updated.username = resolvedUsername;
  if (newPassword) updated.password = newPassword;

  if (config.default === sw.name && newName !== sw.name) {
    config.default = newName;
  }

  config.switches[index] = updated;
  saveConfig(config);
  console.log(`\nUpdated "${newName}".`);
}

async function mainMenu() {
  while (true) {
    clear();
    printHeader();

    const config = loadConfig();
    printSwitches(config.switches, config.default);

    console.log("  a  Add switch");
    console.log("  e  Edit switch");
    console.log("  r  Remove switch");
    console.log("  d  Set default switch");
    console.log("  t  Test connection");
    console.log("  q  Quit\n");

    const choice = await ask("Choice: ");

    switch (choice.toLowerCase()) {
      case "a": await addSwitch(); break;
      case "e": await editSwitch(); break;
      case "r": await removeSwitch(); break;
      case "d": await setDefault(); break;
      case "t": await testConnection(); break;
      case "q":
        rl.close();
        process.exit(0);
      default:
        console.log("\nUnknown option.");
    }

    if (choice.toLowerCase() !== "q") {
      await ask("\nPress Enter to continue...");
    }
  }
}

mainMenu().catch((err) => {
  console.error(err);
  process.exit(1);
});
