import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8000);
const remoteListUrl = "https://web.345569.xyz/api/lkjhgfdsa";
const jwtSecret = "MXKhLXhvct1jzXBqSXItKjAyNA==";
const wasmBase64 = "AGFzbQEAAAABDQNgAAF/YAAAYAF/AX8DBQQBAgAABAUBcAEBAQUDAQAEBhgEfwBBAAt/AEEcC38AQYACC38AQYCAAgsHOAUEaW5pdAAAB2RlY3J5cHQAAQtnZXRJbnB1dFB0cgACDGdldE91dHB1dFB0cgADBm1lbW9yeQIACQYBAEEBCwAKqwMEswIAIwBBAGpBzQA6AAAjAEEBakHYADoAACMAQQJqQcsAOgAAIwBBA2pB6AA6AAAjAEEEakHMADoAACMAQQVqQdgAOgAAIwBBBmpB6AA6AAAjAEEHakH2ADoAACMAQQhqQeMAOgAAIwBBCWpB9AA6AAAjAEEKakExOgAAIwBBC2pB6gA6AAAjAEEMakH6ADoAACMAQQ1qQdgAOgAAIwBBDmpBwgA6AAAjAEEPakHxADoAACMAQRBqQdMAOgAAIwBBEWpB2AA6AAAjAEESakHJADoAACMAQRNqQfQAOgAAIwBBFGpBywA6AAAjAEEVakHqADoAACMAQRZqQcEAOgAAIwBBF2pB+QA6AAAjAEEYakHOADoAACMAQRlqQcEAOgAAIwBBGmpBPToAACMAQRtqQT06AAALaAEFfyAAQQhMBEBBAA8LIABBCGshAUEAIQIDQCACIAFIBEAjAiACQQhvai0AACEDIwAgAiADaiMBb2otAAAhBCMCQQhqIAJqLQAAIQUjAyACaiAFIARzOgAAIAJBAWohAgwBCwsgAQ8LBQAjAg8LBQAjAw8L";

let wasmExportsPromise;
let cachedImpact;
let cachedAt = 0;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname === "/api/nasdaq-impact") {
      const data = await loadNasdaqImpact();
      sendJson(response, 200, data);
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(root, normalizedPath);
    if (!filePath.startsWith(root)) {
      sendText(response, 403, "Forbidden");
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    response.end(body);
  } catch (error) {
    const status = error?.code === "ENOENT" ? 404 : 500;
    sendText(response, status, status === 404 ? "Not found" : error.message || "Server error");
  }
}).listen(port, () => {
  console.log(`Public Nasdaq fund calculator: http://localhost:${port}/`);
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
  response.end(JSON.stringify(body));
}

function sendText(response, status, body) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}
