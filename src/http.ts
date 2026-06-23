import net from "node:net";
import { DEFAULT_TIMEOUT_MS, PASSWORD_SALT, PASSWORD_TABLE } from "./constants.js";
import type { HttpResult } from "./types.js";

export function normalizeTarget(host?: string): URL {
  const raw = host?.trim() || process.env.TPLINK_HOST || "192.168.3.10";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return new URL(withScheme);
}

export function encodeTplinkPassword(password: string): string {
  let encoded = "";
  const maxLen = Math.max(password.length, PASSWORD_SALT.length);

  for (let i = 0; i < maxLen; i += 1) {
    let left = 187;
    let right = 187;

    if (i >= password.length) {
      right = PASSWORD_SALT.charCodeAt(i);
    } else if (i >= PASSWORD_SALT.length) {
      left = password.charCodeAt(i);
    } else {
      left = password.charCodeAt(i);
      right = PASSWORD_SALT.charCodeAt(i);
    }

    encoded += PASSWORD_TABLE.charAt((left ^ right) % PASSWORD_TABLE.length);
  }

  return encoded;
}

export function timeoutMs(): number {
  const parsed = Number(process.env.TPLINK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs(), () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function httpRequest(
  url: URL,
  options: {
    method: "GET" | "POST";
    body?: BodyInit | null;
    headers?: Record<string, string>;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = bodyToString(options.body);
    const headers: Record<string, string | number> = {
      "User-Agent": "Mozilla/5.0 tplink-easy-smart-switch-mcp",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9,zh-HK;q=0.8,zh;q=0.7,en-US;q=0.6,zh-TW;q=0.5,zh-CN;q=0.4",
      Connection: "close",
      "Upgrade-Insecure-Requests": "1",
      ...(options.headers ?? {}),
    };

    if (body !== undefined && headers["Content-Length"] === undefined) {
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const port = Number(url.port || 80);
    const socket = net.createConnection({ host: url.hostname, port });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;

      const raw = Buffer.concat(chunks);
      if (raw.length === 0) {
        reject(new Error("HTTP connection closed without response data"));
        return;
      }

      resolve(parseRawHttpResponse(url, raw));
    };

    socket.setTimeout(timeoutMs(), () => {
      socket.destroy(new Error(`HTTP timeout after ${timeoutMs()}ms`));
    });

    socket.on("connect", () => {
      const head = [
        `${options.method} ${url.pathname}${url.search || ""} HTTP/1.0`,
        `Host: ${url.host}`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        "",
        "",
      ].join("\r\n");

      socket.write(head);
      if (body !== undefined) {
        socket.write(body);
      }
    });

    socket.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    socket.on("close", finish);
    socket.on("end", finish);
    socket.on("error", (error) => {
      if (chunks.length > 0) {
        finish();
        return;
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function parseRawHttpResponse(url: URL, raw: Buffer): HttpResult {
  const marker = raw.indexOf("\r\n\r\n");
  const splitAt = marker === -1 ? raw.indexOf("\n\n") : marker;
  const separatorLength = marker === -1 ? 2 : 4;
  const head = splitAt === -1 ? "" : raw.slice(0, splitAt).toString("latin1");
  const bodyBuffer = splitAt === -1 ? raw : raw.slice(splitAt + separatorLength);
  const lines = head.split(/\r?\n/).filter(Boolean);
  const status = Number(lines[0]?.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? 0);
  const headers: Record<string, string | string[] | undefined> = {};

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const existing = headers[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing !== undefined) {
      headers[key] = [existing, value];
    } else {
      headers[key] = value;
    }
  }

  return {
    status,
    url: url.toString(),
    headers,
    body: decodeBody(bodyBuffer, headers),
    raw_head: head,
  };
}

function decodeBody(body: Buffer, headers: Record<string, string | string[] | undefined>): string {
  const transferEncoding = headerValue(headers, "transfer-encoding").toLowerCase();
  const payload = transferEncoding.includes("chunked") ? decodeChunkedBody(body) : body;
  return payload.toString("utf8");
}

function decodeChunkedBody(body: Buffer): Buffer {
  const out: Buffer[] = [];
  let offset = 0;

  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const sizeText = body.slice(offset, lineEnd).toString("ascii").split(";")[0]?.trim() ?? "";
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    const end = start + size;
    if (end > body.length) {
      out.push(body.slice(start, body.length));
      break;
    }
    out.push(body.slice(start, end));
    offset = end + 2;
  }

  return Buffer.concat(out);
}

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

function bodyToString(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString();
  throw new Error("Unsupported request body type");
}
