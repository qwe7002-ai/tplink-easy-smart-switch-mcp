import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type PendingRequest = {
  resolve: (value: JsonRpcMessage) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const args = parseArgs(process.argv.slice(2));
const command = args.exe ?? defaultExecutable();
const timeoutMs = Number(args.timeout ?? process.env.DEBUG_TIMEOUT_MS ?? 15000);
const child = spawn(command, [], {
  env: {
    ...process.env,
    TPLINK_HOST: args.host ?? process.env.TPLINK_HOST ?? "192.168.3.10",
    TPLINK_USERNAME: args.username ?? process.env.TPLINK_USERNAME,
    TPLINK_PASSWORD: args.password ?? process.env.TPLINK_PASSWORD,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map<number, PendingRequest>();
let nextID = 1;
let stdoutBuffer = "";
let stderrBuffer = "";

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();
  drainStdout();
});

child.stderr.on("data", (chunk) => {
  stderrBuffer += chunk.toString();
});

child.on("exit", (code, signal) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(`MCP process exited: code=${code}, signal=${signal}`));
  }
  pending.clear();
});

try {
  await initialize();

  if (args.raw) {
    await sendRaw(args.raw);
} else if (args.tool) {
    await callTool(args.tool, toolArguments());
  } else {
    await listTools();
  }
} finally {
  child.kill();
}

function toolArguments(): Record<string, unknown> {
  const parsed = args.params ? JSON.parse(args.params) : {};
  const out: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};

  for (const key of ["host", "username", "password"]) {
    if (args[key] !== undefined && out[key] === undefined) {
      out[key] = args[key];
    }
  }

  return out;
}

async function initialize(): Promise<void> {
  const response = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "tplink-easy-smart-switch-debugger",
      version: "0.1.0",
    },
  });
  printSection("initialize", response);
  notify("notifications/initialized", {});
}

async function listTools(): Promise<void> {
  const response = await request("tools/list", {});
  printSection("tools/list", response);
}

async function callTool(name: string, toolArgs: unknown): Promise<void> {
  const response = await request("tools/call", {
    name,
    arguments: toolArgs,
  });
  printSection(`tools/call ${name}`, response);
}

async function sendRaw(raw: string): Promise<void> {
  const message = JSON.parse(raw) as JsonRpcMessage;
  if (message.id === undefined) {
    notify(message.method ?? "", message.params);
    printSection("raw notification sent", message);
    return;
  }

  const response = await request(message.method ?? "", message.params, message.id);
  printSection("raw response", response);
}

function request(method: string, params: unknown, forcedID?: number): Promise<JsonRpcMessage> {
  const id = forcedID ?? nextID++;
  const message: JsonRpcMessage = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for response to ${method}. stderr=${stderrBuffer.trim()}`));
    }, timeoutMs);

    pending.set(id, { resolve: resolveRequest, reject, timer });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function notify(method: string, params: unknown): void {
  const message: JsonRpcMessage = {
    jsonrpc: "2.0",
    method,
    params,
  };
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function drainStdout(): void {
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline === -1) {
      return;
    }

    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);

    if (!line) {
      continue;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      console.error(`Non-JSON stdout: ${line}`);
      continue;
    }

    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id)!;
      clearTimeout(request.timer);
      pending.delete(message.id);
      request.resolve(message);
    } else {
      printSection("server message", message);
    }
  }
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }

  return out;
}

function defaultExecutable(): string {
  const exe = resolve("dist", process.platform === "win32" ? "tplink-easy-smart-switch-mcp.exe" : "tplink-easy-smart-switch-mcp");
  if (!existsSync(exe)) {
    throw new Error(`Cannot find MCP executable: ${exe}. Run bun run build:win first.`);
  }
  return exe;
}

function printSection(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
}
