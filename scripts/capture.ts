/**
 * Capture read-only Web UI snapshots from a TP-Link / Mercury Easy Smart switch.
 *
 * Usage:
 *   bun run scripts/capture.ts --host 192.168.3.10 [--username admin] [--password secret] [--out examples]
 *
 * The script logs in (if credentials are supplied), fetches every parser-relevant
 * page, strips cookies / session tokens from the saved HTML, and writes a
 * directory tree under --out/<host>/ that mirrors the existing examples/.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { httpRequest, normalizeTarget, encodeTplinkPassword, tcpOpen } from "../src/http.js";
import { rememberCookies, cookieHeader, clearSession } from "../src/session.js";
import { VENDOR_LOGIN_LABEL } from "../src/constants.js";

const PAGES = [
  { path: "/MainRpm.htm",           file: "MainRpm.htm" },
  { path: "/Menu.htm",              file: "Menu.htm" },
  { path: "/VlanPortBasicRpm.htm",  file: "VlanPortBasicRpm.htm" },
  { path: "/Vlan8021QRpm.htm",      file: "Vlan8021QRpm.htm" },
  { path: "/Vlan8021QPvidRpm.htm",  file: "Vlan8021QPvidRpm.htm" },
  { path: "/VlanMtuRpm.htm",        file: "VlanMtuRpm.htm" },
  { path: "/PortTrunkRpm.htm",      file: "PortTrunkRpm.htm" },
  { path: "/MacSearchRpm.htm",      file: "MacSearchRpm.htm" },
  { path: "/SavingConfigRpm.htm",   file: "SavingConfigRpm.htm" },
  { path: "/ConfigRpm.htm",         file: "ConfigRpm.htm" },
  { path: "/menuList.js",           file: "assets/menuList.js" },
  { path: "/pvlan.js",              file: "assets/pvlan.js" },
  { path: "/qvlan.js",              file: "assets/qvlan.js" },
];

interface CaptureResult {
  path: string;
  file: string;
  status: number;
  bytes: number;
  looksLikeLogin: boolean;
  error?: string;
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      out[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function stripSessionData(html: string): string {
  return html
    // Remove token values (top.g_tid assignments)
    .replace(/((?:top\.)?g_tid\s*=\s*["'])[^"']+(?=["'])/gi, "$1<redacted>")
    // Remove cookie values from any document.cookie assignments
    .replace(/(document\.cookie\s*=\s*["'])[^"']+(?=["'])/gi, "$1<redacted>");
}

function looksLikeLogin(html: string): boolean {
  return /submitForm|plain_password|logonInfo\s*=\s*new Array\(\s*[1-9]/i.test(html);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const host = args.host ?? process.env.TPLINK_HOST ?? "192.168.3.10";
  const username = args.username ?? process.env.TPLINK_USERNAME;
  const password = args.password ?? process.env.TPLINK_PASSWORD;
  const outDir = args.out ?? "examples";

  const target = normalizeTarget(host);
  const destDir = join(outDir, host);

  console.log(`Target : ${target.origin}`);
  console.log(`Output : ${destDir}/`);
  console.log();

  // TCP probe
  const open = await tcpOpen(target.hostname, 80);
  if (!open) {
    console.error(`ERROR: ${target.hostname}:80 is not reachable.`);
    process.exit(1);
  }

  // Optionally log in
  let loginStatus: number | null = null;
  if (username && password) {
    console.log(`Logging in as "${username}" …`);
    clearSession(target);

    const loginPage = await httpRequest(new URL("/", target.origin), { method: "GET", headers: {} });
    rememberCookies(target, loginPage);

    const body = new URLSearchParams({
      username,
      password: encodeTplinkPassword(password),
      logon: VENDOR_LOGIN_LABEL,
    });

    const loginResponse = await httpRequest(new URL("/logon.cgi", target.origin), {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "max-age=0",
        Referer: `${target.origin}/`,
        Cookie: cookieHeader(target),
      },
    });
    rememberCookies(target, loginResponse);
    loginStatus = loginResponse.status;

    const gotCookies = cookieHeader(target) !== "";
    console.log(`  status=${loginStatus}  cookies_saved=${gotCookies}`);
    if (!gotCookies) {
      console.warn("  WARNING: No session cookie received — pages may redirect to login.");
    }
    console.log();
  } else {
    console.log("No credentials supplied — fetching without login.");
    console.log();
  }

  // Create output directories
  mkdirSync(join(destDir, "assets"), { recursive: true });

  const results: CaptureResult[] = [];

  for (const page of PAGES) {
    process.stdout.write(`  Fetching ${page.path} … `);

    try {
      const cookies = cookieHeader(target);
      const response = await httpRequest(new URL(page.path, target.origin), {
        method: "GET",
        headers: cookies ? { Cookie: cookies } : {},
      });

      const isLogin = looksLikeLogin(response.body);
      const stripped = stripSessionData(response.body);
      const destPath = join(destDir, page.file);

      writeFileSync(destPath, stripped, "utf8");

      const result: CaptureResult = {
        path: page.path,
        file: page.file,
        status: response.status,
        bytes: Buffer.byteLength(stripped),
        looksLikeLogin: isLogin,
      };
      results.push(result);

      const flag = isLogin ? " [LOGIN PAGE]" : "";
      console.log(`${response.status} (${result.bytes} bytes)${flag}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ path: page.path, file: page.file, status: 0, bytes: 0, looksLikeLogin: false, error: message });
      console.log(`ERROR: ${message}`);
    }
  }

  // Write manifest
  const manifest = {
    target: target.origin,
    fetchedAt: new Date().toISOString(),
    loginStatus,
    note: "Read-only GET snapshots for MCP development. No cookies, session IDs, or passwords are stored.",
    files: results.filter((r) => !r.error).map(({ error: _e, ...rest }) => rest),
  };

  writeFileSync(join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log();
  console.log(`Saved ${results.filter((r) => !r.error).length}/${PAGES.length} files → ${destDir}/`);

  const loginPages = results.filter((r) => r.looksLikeLogin);
  if (loginPages.length > 0) {
    console.log();
    console.log(`WARNING: ${loginPages.length} page(s) returned a login page instead of data:`);
    for (const p of loginPages) console.log(`  ${p.path}`);
    console.log("  Re-run with --username and --password to capture authenticated pages.");
  }

  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    console.log();
    console.log(`${errors.length} page(s) failed:`);
    for (const p of errors) console.log(`  ${p.path}: ${p.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
