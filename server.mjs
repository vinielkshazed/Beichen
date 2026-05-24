import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "0.0.0.0";
const remoteListUrl = "https://web.345569.xyz/api/lkjhgfdsa";
const jwtSecret = "MXKhLXhvct1jzXBqSXItKjAyNA==";
const wasmBase64 = "AGFzbQEAAAABDQNgAAF/YAAAYAF/AX8DBQQBAgAABAUBcAEBAQUDAQAEBhgEfwBBAAt/AEEcC38AQYACC38AQYCAAgsHOAUEaW5pdAAAB2RlY3J5cHQAAQtnZXRJbnB1dFB0cgACDGdldE91dHB1dFB0cgADBm1lbW9yeQIACQYBAEEBCwAKqwMEswIAIwBBAGpBzQA6AAAjAEEBakHYADoAACMAQQJqQcsAOgAAIwBBA2pB6AA6AAAjAEEEakHMADoAACMAQQVqQdgAOgAAIwBBBmpB6AA6AAAjAEEHakH2ADoAACMAQQhqQeMAOgAAIwBBCWpB9AA6AAAjAEEKakExOgAAIwBBC2pB6gA6AAAjAEEMakH6ADoAACMAQQ1qQdgAOgAAIwBBDmpBwgA6AAAjAEEPakHxADoAACMAQRBqQdMAOgAAIwBBEWpB2AA6AAAjAEESakHJADoAACMAQRNqQfQAOgAAIwBBFGpBywA6AAAjAEEVakHqADoAACMAQRZqQcEAOgAAIwBBF2pB+QA6AAAjAEEYakHOADoAACMAQRlqQcEAOgAAIwBBGmpBPToAACMAQRtqQT06AAALaAEFfyAAQQhMBEBBAA8LIABBCGshAUEAIQIDQCACIAFIBEAjAiACQQhvai0AACEDIwAgAiADaiMBb2otAAAhBCMCQQhqIAJqLQAAIQUjAyACaiAFIARzOgAAIAJBAWohAgwBCwsgAQ8LBQAjAg8LBQAjAw8L";

let wasmExportsPromise;
let cachedImpact;
let cachedAt = 0;
const apiHits = new Map();
const apiWindowMs = 60_000;
const apiMaxHits = 60;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

createServer(async (request, response) => {
  try {
    setSecurityHeaders(response, request);
    if (!["GET", "HEAD"].includes(request.method || "")) {
      sendText(response, 405, "Method not allowed");
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname === "/api/nasdaq-impact") {
      if (!checkRateLimit(request)) {
        sendText(response, 429, "Too many requests");
        return;
      }
      const data = await loadNasdaqImpact();
      sendJson(response, 200, data);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      sendText(response, 404, "Not found");
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(root, normalizedPath);
    if (!filePath.startsWith(root)) {
      sendText(response, 403, "Forbidden");
      return;
    }

    const body = request.method === "HEAD" ? "" : await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    response.end(body);
  } catch (error) {
    const status = error?.code === "ENOENT" ? 404 : 500;
    sendText(response, status, status === 404 ? "Not found" : error.message || "Server error");
  }
}).listen(port, host, () => {
  console.log(`Public Nasdaq fund calculator: http://${host}:${port}/`);
});

async function loadNasdaqImpact() {
  const now = Date.now();
  if (cachedImpact && now - cachedAt < 10_000) return cachedImpact;

  const remote = await fetch(remoteListUrl, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${createJwt()}`
    }
  });

  if (!remote.ok) throw new Error(`纳指估值接口请求失败：${remote.status}`);
  const payload = await remote.json();
  const parsed = payload?.encrypted && typeof payload.data === "string"
    ? JSON.parse(await decryptPayload(payload.data))
    : payload;
  const data = Array.isArray(parsed) ? parsed[1] : parsed;
  cachedImpact = { ...data, fetchedAt: new Date().toISOString(), sourceUrl: "https://web.345569.xyz/" };
  cachedAt = now;
  return cachedImpact;
}

async function decryptPayload(base64) {
  const wasm = await loadWasmExports();
  const input = Buffer.from(base64, "base64");
  const memory = new Uint8Array(wasm.memory.buffer);
  memory.set(input, wasm.getInputPtr());
  const length = wasm.decrypt(input.length);
  const outputStart = wasm.getOutputPtr();
  return Buffer.from(memory.slice(outputStart, outputStart + length)).toString("utf8");
}

async function loadWasmExports() {
  if (!wasmExportsPromise) {
    wasmExportsPromise = WebAssembly.instantiate(Buffer.from(wasmBase64, "base64")).then(({ instance }) => {
      instance.exports.init();
      return instance.exports;
    });
  }
  return wasmExportsPromise;
}

function createJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now, exp: now + 300, nbf: now - 5 }));
  const signature = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(response.req?.method === "HEAD" ? "" : JSON.stringify(body));
}

function sendText(response, status, body) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(response.req?.method === "HEAD" ? "" : body);
}

function setSecurityHeaders(response, request) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' https://fundgz.1234567.com.cn",
    "connect-src 'self' https://api.frankfurter.dev https://cdn.jsdelivr.net"
  ].join("; "));

  if (request.headers["x-forwarded-proto"] === "https") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function checkRateLimit(request) {
  const now = Date.now();
  const forwardedFor = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const key = forwardedFor || request.socket.remoteAddress || "unknown";
  const entry = apiHits.get(key);
  if (!entry || now - entry.startedAt > apiWindowMs) {
    apiHits.set(key, { startedAt: now, hits: 1 });
    pruneRateLimits(now);
    return true;
  }
  entry.hits += 1;
  return entry.hits <= apiMaxHits;
}

function pruneRateLimits(now) {
  for (const [key, entry] of apiHits) {
    if (now - entry.startedAt > apiWindowMs) apiHits.delete(key);
  }
}
