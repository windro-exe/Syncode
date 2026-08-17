// zcode-proxy — local OpenAI-compatible proxy for Z.AI / BigModel GLM plans.
// Zero-dep core (jsdom OPTIONAL, only for the Aliyun captcha solver used by
// the account-based Start Plan gateway).
//
// Two upstream modes, auto-detected per credential:
//   coding-plan  (API key)   -> provider anthropic base, x-api-key auth
//   start-plan   (account)   -> zcode.z.ai gateway, Authorization: Bearer <jwt>
//                               + Aliyun captcha token when challenged
//
// Credentials (in order):
//   1. ~/.config/zcode-proxy/credentials.json  (from `auth login`)
//   2. ZCODE_API_KEY env or ~/.config/zcode-proxy/key (coding-plan API key)
//
// Commands:
//   node proxy.mjs               run server (default port 8788)
//   node proxy.mjs auth login    OAuth login for Z.ai (free Start Plan account)
//   node proxy.mjs auth login bigmodel
//
// Upstream facts (verified 2026-08-16 against ZCode bundle + lkonga/zcode-api-public):
//   zai auth:  https://chat.z.ai/api/oauth/authorize  appId=client_P8X5CMWmlaRO9gyO-KSqtg
//   token:     POST https://zcode.z.ai/api/v1/oauth/token {provider,code,redirect_uri,state}
//              -> { code:0, data:{ token:<jwt>, zai:{access_token}, user:{user_id} } }
//   start-plan:  https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages (Bearer jwt)
//   zai coding:  https://api.z.ai/api/anthropic/v1/messages  (x-api-key)
//   bigmodel:    https://open.bigmodel.cn/api/anthropic/v1/messages (x-api-key)
//   captcha cfg: https://zcode.z.ai/api/v1/client/configs?app_version=..&platform=win32-x64
//   challenge:   response header x-aliyun-captcha-verify-param (+ region header)

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------- config ----------------
const PORT = Number(process.env.ZCODE_PROXY_PORT || 8788);
const HOST = process.env.ZCODE_PROXY_HOST || "127.0.0.1";
const DEFAULT_MODEL = process.env.ZCODE_DEFAULT_MODEL || "glm-5.3";
const CLIENT_TOKEN = process.env.ZCODE_PROXY_TOKEN || null;
const APP_VERSION = process.env.ZCODE_APP_VERSION || "3.1.1";

const CONFIG_DIR = join(homedir(), ".config", "zcode-proxy");
const CRED_FILE = join(CONFIG_DIR, "credentials.json");
const KEY_FILE = join(CONFIG_DIR, "key");

const ZCODE_TOKEN_ENDPOINT = "https://zcode.z.ai/api/v1/oauth/token";
const STARTPLAN_BASE = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
const PROVIDER_BASES = {
  zai: "https://api.z.ai/api/anthropic",
  bigmodel: "https://open.bigmodel.cn/api/anthropic",
};
const CAPTCHA_CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";
const ANTHROPIC_VERSION = "2023-06-01";

const MODELS = ["glm-5.3", "glm-5.2", "glm-5-turbo", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"];

const rnd = (n = 8) => randomBytes(n).toString("hex");

// ---------------- credentials ----------------
function loadCredentials() {
  if (existsSync(CRED_FILE)) {
    try { return JSON.parse(readFileSync(CRED_FILE, "utf8")); } catch {}
  }
  return null;
}
function saveCredentials(cred) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2));
}
function loadApiKey() {
  if (process.env.ZCODE_API_KEY && process.env.ZCODE_API_KEY.trim()) return process.env.ZCODE_API_KEY.trim();
  if (existsSync(KEY_FILE)) {
    const k = readFileSync(KEY_FILE, "utf8").trim();
    if (k) return k;
  }
  return null;
}

// credential struct: { mode: "start-plan"|"coding-plan", jwt?, apiKey?, provider, userId? }
function resolveCredential() {
  const cred = loadCredentials();
  if (cred?.jwt && cred?.provider) {
    return { mode: "start-plan", jwt: cred.jwt, provider: cred.provider, userId: cred.userId };
  }
  const key = loadApiKey();
  if (key) {
    return { mode: "coding-plan", apiKey: key, provider: (process.env.ZCODE_PROVIDER || "zai").toLowerCase() };
  }
  return null;
}

// ---------------- OAuth login ----------------
const AUTH_CONFIGS = {
  zai: {
    authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
    appId: "client_P8X5CMWmlaRO9gyO-KSqtg",
    callbackPath: "/oauth/callback/zai",
    style: "oauth2",
  },
  bigmodel: {
    authorizeUrl: "https://bigmodel.cn/login",
    appId: "zcode",
    callbackPath: "/oauth/callback/bigmodel",
    style: "zcode",
  },
};

async function authLogin(provider) {
  const cfg = AUTH_CONFIGS[provider];
  if (!cfg) {
    console.error("provider must be zai or bigmodel");
    process.exit(1);
  }
  const state = rnd(16);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== cfg.callbackPath) {
      res.writeHead(404); res.end("Not found"); return;
    }
    const gotCode = url.searchParams.get("authCode") || url.searchParams.get("code") || "";
    const gotState = url.searchParams.get("state") || "";
    if (gotState !== state || !gotCode) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("Authorization failed: state mismatch or missing code. Close this tab and retry.");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("Authorization OK! You can close this tab and go back to the terminal.");
    void exchangeCode(gotCode, callbackUrl, state, provider).then((tok) => {
      complete(tok);
    }).catch((e) => {
      console.error("token exchange failed:", e.message);
      process.exit(1);
    });
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const callbackUrl = `http://127.0.0.1:${port}${cfg.callbackPath}`;
  const params = cfg.style === "oauth2"
    ? new URLSearchParams({ redirect_uri: callbackUrl, response_type: "code", client_id: cfg.appId, state })
    : new URLSearchParams({ appId: cfg.appId, redirect: callbackUrl, state });
  const authorizeUrl = `${cfg.authorizeUrl}?${params}`;

  console.log(`\nOpen this URL in your browser and log in with your ${provider} account:\n\n  ${authorizeUrl}\n`);
  spawn("cmd", ["/c", "start", "", authorizeUrl], { detached: true, stdio: "ignore" }).unref();

  let complete;
  const done = new Promise((r) => (complete = r));
  await done; // keeps process alive until callback handled
}

async function exchangeCode(code, redirectUri, state, providerArg) {
  const resp = await fetch(ZCODE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: providerArg || "zai", code, redirect_uri: redirectUri, state }),
  });
  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok || (typeof raw.code === "number" && raw.code !== 0)) {
    throw new Error(`token exchange failed: status=${resp.status} msg=${raw.msg || raw.message || "(none)"}`);
  }
  const accessToken = raw?.data?.zai?.access_token || raw?.data?.bigmodel?.access_token || "";
  const jwt = (raw?.data?.token || "").trim();
  if (!jwt) throw new Error("token response missing data.token (JWT)");
  const userId = typeof raw?.data?.user?.user_id === "string" ? raw.data.user.user_id : undefined;
  const provider = accessToken && raw?.data?.zai ? "zai" : "bigmodel";
  const cred = { mode: "start-plan", provider, jwt, accessToken: accessToken || undefined, userId, savedAt: new Date().toISOString() };
  saveCredentials(cred);
  console.log("\nLogged in. Credentials saved to", CRED_FILE);
  console.log("provider:", provider, "| userId:", userId || "(none)");
  return cred;
}

// ---------------- captcha (jsdom optional) ----------------
const FAKE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function applyPolyfills(window) {
  window.matchMedia = () => ({ matches: false, media: "", onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = function (type) {
    if (/webgl/i.test(type)) return { canvas: this, getParameter: () => "Intel Inc.", getExtension: () => null, getSupportedExtensions: () => ["WEBGL_debug_renderer_info"], getContextAttributes: () => ({}), getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }) };
    return {
      canvas: this, fillRect() {}, clearRect() {}, getImageData: (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {}, createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }), setTransform() {}, transform() {}, drawImage() {},
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {}, clip() {}, stroke() {},
      fill() {}, arc() {}, rect() {}, ellipse() {}, translate() {}, scale() {}, rotate() {}, fillText() {}, strokeText() {},
      measureText: (t) => ({ width: ("" + t).length * 8 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => ({}), isPointInPath: () => false, font: "10px sans-serif", textBaseline: "alphabetic", textAlign: "start",
      fillStyle: "#000", strokeStyle: "#000", globalAlpha: 1, lineWidth: 1, shadowBlur: 0, shadowColor: "",
    };
  };
  proto.toDataURL = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  proto.toBlob = (cb) => cb && cb(null);
  window.Worker = class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} onmessage = null; onerror = null; };
  window.OffscreenCanvas = class { width = 0; height = 0; constructor(w, h) { this.width = w; this.height = h; } getContext() { return proto.getContext.call(this); } };
  try {
    Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
    Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
  } catch {}
  for (const [k, v] of Object.entries({
    userAgent: FAKE_UA, platform: "Win32", language: "en-US", languages: ["en-US", "en"], vendor: "Google Inc.",
    webdriver: false, hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, cookieEnabled: true,
    plugins: { length: 3, item: () => null, namedItem: () => null, refresh() {} },
    mimeTypes: { length: 0, item: () => null, namedItem: () => null },
  })) { try { Object.defineProperty(window.navigator, k, { value: v, configurable: true }); } catch {} }
  window.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  window.chrome = { runtime: {} };
  window.outerWidth = 1920; window.outerHeight = 1080; window.innerWidth = 1280; window.innerHeight = 720; window.devicePixelRatio = 1;
}

let captchaTokenCache = null;
async function solveCaptcha() {
  if (captchaTokenCache && captchaTokenCache.expiresAt > Date.now()) return captchaTokenCache;
  let jsdom;
  try { jsdom = await import("jsdom"); } catch {
    throw new Error("captcha challenge received but jsdom is not installed (run: bun install --ignore-scripts in tools/zcode-proxy)");
  }
  // fetch captcha config
  const cfgResp = await fetch(`${CAPTCHA_CONFIGS_API}?app_version=${encodeURIComponent(APP_VERSION)}&platform=win32-x64`);
  const cfgJson = await cfgResp.json().catch(() => ({}));
  const cfg = cfgJson?.data?.configs?.captcha;
  if (!cfg?.enabled || !cfg.prefix || !cfg.sceneId) throw new Error("captcha config unavailable");
  const sdkRaw = readFileSync(join(__dirname, "AliyunCaptcha.js.txt"), "utf8");
  const sdkSafe = sdkRaw.replace(/<\/script>/gi, "<\\/script>");
  const html = `<!DOCTYPE html><html><head></head><body><div id="captcha-element"></div><button id="captcha-button"></button><script>${sdkSafe}</script></body></html>`;
  const { JSDOM, VirtualConsole } = jsdom;
  const solve = () => new Promise((resolve, reject) => {
    const vc = new VirtualConsole();
    const dom = new JSDOM(html, {
      url: "https://zcode.z.ai/",
      runScripts: "dangerously",
      resources: "usable",
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(window) {
        applyPolyfills(window);
        window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };
      },
    });
    const w = dom.window;
    const timeout = setTimeout(() => { try { w.close(); } catch {} reject(new Error("captcha solve timeout")); }, 40000);
    const waitFor = () => {
      if (typeof w.initAliyunCaptcha === "function") {
        try {
          w.initAliyunCaptcha({
            SceneId: cfg.sceneId, mode: "popup", region: cfg.region, prefix: cfg.prefix, language: "en",
            element: "#captcha-element", button: "#captcha-button", captchaLogoImg: "", showErrorTip: false,
            getInstance(inst) {
              const fn = inst.startTracelessVerification || inst.show;
              if (typeof fn !== "function") { clearTimeout(timeout); try { w.close(); } catch {} reject(new Error("SDK has no startTracelessVerification/show")); return; }
              try { fn.call(inst); } catch (e) { clearTimeout(timeout); try { w.close(); } catch {} reject(e); }
            },
            success(param) { clearTimeout(timeout); try { w.close(); } catch {} resolve(param); },
            fail(err) { clearTimeout(timeout); try { w.close(); } catch {} reject(new Error(`SDK fail: ${JSON.stringify(err)}`)); },
            onError(err) { clearTimeout(timeout); try { w.close(); } catch {} reject(new Error(`SDK error: ${JSON.stringify(err)}`)); },
          });
        } catch (e) { clearTimeout(timeout); reject(e); }
      } else {
        setTimeout(waitFor, 80);
      }
    };
    setTimeout(waitFor, 100);
  });
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const verifyParam = await solve();
      captchaTokenCache = { verifyParam, region: cfg.region, expiresAt: Date.now() + 45000 };
      return captchaTokenCache;
    } catch (e) { lastErr = e; console.error(`[captcha] attempt ${i + 1}/3 failed: ${e.message}`); }
  }
  throw new Error(`captcha solve failed: ${lastErr?.message || "unknown"}`);
}

// ---------------- OpenAI -> Anthropic ----------------
function safeJson(s) {
  try { return s === undefined || s === null ? {} : JSON.parse(s); } catch { return {}; }
}

function toAnthropicBlock(part) {
  if (typeof part === "string" || part?.type === "text") {
    return { type: "text", text: typeof part === "string" ? part : part.text };
  }
  if (part?.type === "image_url" && part.image_url?.url) {
    const u = part.image_url.url;
    const m = /^data:([^;]+);base64,(.*)$/s.exec(u);
    if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    return { type: "image", source: { type: "url", url: u } };
  }
  return null;
}

function translateMessages(messages) {
  const system = [];
  const out = [];
  for (const msg of messages || []) {
    if (msg.role === "system") {
      system.push({ type: "text", text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = [];
      if (typeof msg.content === "string") blocks.push({ type: "text", text: msg.content });
      else for (const p of msg.content || []) { const b = toAnthropicBlock(p); if (b) blocks.push(b); }
      for (const tc of msg.tool_calls || []) {
        blocks.push({ type: "tool_use", id: tc.id || "toolu_" + rnd(), name: tc.function?.name || "tool", input: safeJson(tc.function?.arguments) });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (msg.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.tool_call_id || "", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }],
      });
      continue;
    }
    const blocks = [];
    if (typeof msg.content === "string") blocks.push({ type: "text", text: msg.content });
    else for (const p of msg.content || []) { const b = toAnthropicBlock(p); if (b) blocks.push(b); }
    const last = out[out.length - 1];
    if (last?.role === "user" && !last.content.some((b) => b.type === "tool_result")) {
      last.content.push(...blocks);
    } else {
      out.push({ role: "user", content: blocks });
    }
  }
  return { system, messages: out };
}

function translateTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function?.name || t.name,
    description: t.function?.description || t.description || "",
    input_schema: t.function?.parameters || t.input_schema || { type: "object", properties: {} },
  }));
}

function buildBody(reqBody) {
  const body = {
    model: reqBody.model || DEFAULT_MODEL,
    max_tokens: reqBody.max_tokens ?? reqBody.max_completion_tokens ?? 8192,
    stream: !!reqBody.stream,
  };
  if (reqBody.temperature !== undefined) body.temperature = reqBody.temperature;
  if (reqBody.top_p !== undefined) body.top_p = reqBody.top_p;
  if (reqBody.stop) body.stop_sequences = Array.isArray(reqBody.stop) ? reqBody.stop : [reqBody.stop];
  const { system, messages } = translateMessages(reqBody.messages);
  if (system.length) body.system = system;
  body.messages = messages;
  const tools = translateTools(reqBody.tools);
  if (tools.length) body.tools = tools;
  if (reqBody.tool_choice) {
    body.tool_choice = reqBody.tool_choice === "auto" || reqBody.tool_choice === "none"
      ? { type: reqBody.tool_choice }
      : { type: "tool", name: reqBody.tool_choice.function?.name || reqBody.tool_choice.name };
  }
  return body;
}

// ---------------- Anthropic -> OpenAI ----------------
function mapStop(pr) {
  if (pr === "max_tokens") return "length";
  if (pr === "tool_use") return "tool_calls";
  return "stop";
}

function anthropicToMessage(data) {
  const text = [], thinking = [], tools = [];
  for (const b of data.content || []) {
    if (b.type === "text") text.push(b.text);
    else if (b.type === "thinking") thinking.push(b.thinking);
    else if (b.type === "tool_use") tools.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  }
  const message = { role: "assistant", content: text.join("") || null };
  if (thinking.length) message.reasoning_content = thinking.join("");
  if (tools.length) message.tool_calls = tools;
  return message;
}

function toUsage(u) {
  return {
    prompt_tokens: u?.input_tokens ?? 0,
    completion_tokens: u?.output_tokens ?? 0,
    total_tokens: (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0),
  };
}

// ---------------- upstream ----------------
function identityHeaders() {
  return {
    "user-agent": `ZCode/${APP_VERSION}`,
    "x-zcode-app-version": APP_VERSION,
    "x-title": "Z Code@cli",
    "x-zcode-agent": "glm",
    "http-referer": "https://zcode.z.ai",
    "x-request-id": "req_" + rnd(),
    "x-zcode-trace-id": "trace_" + rnd(),
    "x-query-id": "query_" + rnd(),
    "x-session-id": "session_" + rnd(),
  };
}

function baseHeaders() {
  return {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...identityHeaders(),
  };
}

async function upstreamCall(cred, body, captcha) {
  const url = cred.mode === "start-plan"
    ? `${STARTPLAN_BASE}/v1/messages`
    : `${PROVIDER_BASES[cred.provider] || PROVIDER_BASES.zai}/v1/messages`;
  const headers = baseHeaders();
  if (cred.mode === "start-plan") headers.authorization = `Bearer ${cred.jwt}`;
  else { headers["x-api-key"] = cred.apiKey; headers.authorization = `Bearer ${cred.apiKey}`; }
  if (cred.userId) body.metadata = { ...(body.metadata || {}), user_id: cred.userId };
  if (captcha) {
    headers["x-aliyun-captcha-verify-param"] = captcha.verifyParam;
    headers["x-aliyun-captcha-verify-region"] = captcha.region;
  }
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000),
  });
}

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";

async function upstreamCallWithCaptchaRetry(cred, body) {
  let captcha = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await upstreamCall(cred, body, captcha);
    if (res.status !== 200 && res.headers.get(CAPTCHA_HEADER)) {
      console.log("[captcha] challenge detected, solving…");
      captcha = await solveCaptcha();
      continue;
    }
    return res;
  }
  return null; // all attempts consumed by challenges
}

// ---------------- streaming translation ----------------
function pipeStream(upstreamRes, reqBody, res) {
  const created = Math.floor(Date.now() / 1000);
  const oid = "chatcmpl-" + rnd();
  const model = reqBody.model || DEFAULT_MODEL;
  const includeUsage = !!reqBody.stream_options?.include_usage;
  let first = true;
  let usage = null;

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, finish = null) => send({
    id: oid, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  let buf = "";
  let evt = null;
  const onLine = (line) => {
    if (line.startsWith("event:")) { evt = line.slice(6).trim(); return; }
    if (evt && line.startsWith("data:")) {
      const d = line.slice(5).trim();
      try {
        if (evt === "content_block_start") {
          const cb = JSON.parse(d);
          if (first) {
            chunk(cb.content_block?.type === "thinking" ? { role: "assistant", content: "", reasoning_content: "" } : { role: "assistant", content: "" });
            first = false;
          }
          if (cb.content_block?.type === "tool_use") {
            chunk({ tool_calls: [{ index: cb.index, id: cb.content_block.id, type: "function", function: { name: cb.content_block.name, arguments: "" } }] });
          }
        } else if (evt === "content_block_delta") {
          const db = JSON.parse(d);
          const delta = db.delta || {};
          if (delta.type === "text_delta") chunk({ content: delta.text });
          else if (delta.type === "thinking_delta") chunk({ reasoning_content: delta.thinking });
          else if (delta.type === "input_json_delta") chunk({ tool_calls: [{ index: db.index, function: { arguments: delta.partial_json } }] });
        } else if (evt === "message_delta") {
          const md = JSON.parse(d);
          if (md.usage) usage = md.usage;
          if (md.delta?.stop_reason) chunk({}, mapStop(md.delta.stop_reason));
        } else if (evt === "message_stop") {
          if (includeUsage && usage) send({ id: oid, object: "chat.completion.chunk", created, model, choices: [], usage: toUsage(usage) });
          res.write("data: [DONE]\n\n");
          res.end();
        } else if (evt === "error") {
          const er = JSON.parse(d);
          send({ error: { message: er.error?.message || "upstream error", type: er.error?.type || "zcode_upstream_error" } });
          res.end();
        }
      } catch {}
      evt = null;
    }
  };

  upstreamRes.body.on("data", (buf_) => {
    buf += buf_.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line.trim());
  });
  upstreamRes.body.on("end", () => {
    if (!res.writableEnded) {
      if (includeUsage && usage) send({ id: oid, object: "chat.completion.chunk", created, model, choices: [], usage: toUsage(usage) });
      chunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });
  upstreamRes.body.on("error", () => {
    if (!res.writableEnded) {
      chunk({}, "length");
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });
}

// ---------------- HTTP helpers ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function errBody(status, message, type = "zcode_proxy_error") {
  return { error: { message, type } };
}

// ---------------- CLI ----------------
if (process.argv[2] === "auth" && process.argv[3] === "login") {
  const provider = process.argv[4] === "bigmodel" ? "bigmodel" : "zai";
  await authLogin(provider);
  process.exit(0);
}

// ---------------- server ----------------
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const started = Date.now();

  if (CLIENT_TOKEN && (req.headers.authorization || "") !== `Bearer ${CLIENT_TOKEN}`) {
    return json(res, 401, errBody(401, "Invalid client token", "authentication_error"));
  }

  if ((path === "/v1/models" || path === "/models") && req.method === "GET") {
    return json(res, 200, {
      object: "list",
      data: MODELS.map((m) => ({ id: m, object: "model", owned_by: "zai", created: 0, context_window: 160000, max_output_tokens: 8192 })),
    });
  }

  if (path === "/healthz" && req.method === "GET") {
    const cred = resolveCredential();
    return json(res, 200, {
      ok: true,
      mode: cred ? cred.mode : "unconfigured",
      provider: cred?.provider || null,
      upstream: cred?.mode === "start-plan" ? STARTPLAN_BASE : PROVIDER_BASES[(process.env.ZCODE_PROVIDER || "zai").toLowerCase()],
    });
  }

  if (path !== "/v1/chat/completions" || req.method !== "POST") {
    return json(res, 404, errBody(404, `Not found: ${req.method} ${path}`));
  }

  const raw = [];
  req.on("data", (c) => raw.push(c));
  req.on("end", async () => {
    let reqBody;
    try { reqBody = JSON.parse(Buffer.concat(raw).toString("utf8")); }
    catch { return json(res, 400, errBody(400, "Invalid JSON body", "invalid_request_error")); }

    const cred = resolveCredential();
    if (!cred) {
      return json(res, 500, errBody(500, "No credentials. Run `node proxy.mjs auth login` (free Start Plan account) or set ZCODE_API_KEY for a coding-plan key."));
    }
    if (!reqBody.messages?.length) return json(res, 400, errBody(400, "messages is required", "invalid_request_error"));

    try {
      const upstreamRes = await upstreamCallWithCaptchaRetry(cred, buildBody(reqBody));
      if (!upstreamRes) return json(res, 502, errBody(502, "upstream unreachable after captcha retries"));
      if (upstreamRes.status !== 200) {
        let msg = `upstream ${upstreamRes.status}`;
        try { const j = await upstreamRes.json(); msg = j?.error?.message || j?.message || msg; } catch {}
        console.log(`${new Date().toISOString()} POST ${reqBody.model} ${upstreamRes.status} ${Date.now() - started}ms ${msg}`);
        return json(res, upstreamRes.status, errBody(upstreamRes.status, msg, "zcode_upstream_error"));
      }
      if (reqBody.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.flushHeaders();
        pipeStream(upstreamRes, reqBody, res);
      } else {
        const j = await upstreamRes.json();
        const out = {
          id: j.id || "chatcmpl-" + rnd(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: reqBody.model || DEFAULT_MODEL,
          choices: [{ index: 0, message: anthropicToMessage(j), finish_reason: mapStop(j.stop_reason) }],
          usage: toUsage(j.usage),
        };
        console.log(`${new Date().toISOString()} POST ${reqBody.model} 200 ${Date.now() - started}ms ok`);
        return json(res, 200, out);
      }
    } catch (e) {
      console.log(`${new Date().toISOString()} POST ${reqBody.model} ERR ${e.message}`);
      return json(res, 502, errBody(502, `Upstream fetch failed: ${e.message}`));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`zcode-proxy v0.2.0 listening on http://${HOST}:${PORT}`);
  const cred = resolveCredential();
  if (cred) console.log(`mode: ${cred.mode} (${cred.provider})${cred.userId ? `, user ${cred.userId}` : ""}`);
  else console.log("no credentials yet — run `node proxy.mjs auth login` (free Start Plan) or set ZCODE_API_KEY");
  console.log(`default model: ${DEFAULT_MODEL}`);
});