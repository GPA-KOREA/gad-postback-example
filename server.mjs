import http from "node:http";
import {appendFileSync, closeSync, fstatSync, lstatSync, openSync, readFileSync} from "node:fs";
import {createHash, timingSafeEqual} from "node:crypto";
import {isAbsolute, resolve} from "node:path";
import {fileURLToPath} from "node:url";

export const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS = 10_000;
const FIELD_NAMES = ["seq", "media", "adKey", "adTitle", "uid", "publisher_data", "point"];

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid configuration");
  const mediaKeys = config.mediaKeys;
  if (!Array.isArray(mediaKeys) || mediaKeys.length < 1 || mediaKeys.length > 10 ||
      mediaKeys.some(key => typeof key !== "string" || !key || key.length > 200) ||
      new Set(mediaKeys).size !== mediaKeys.length) throw new Error("Invalid media configuration");
  if (typeof config.pathToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(config.pathToken)) {
    throw new Error("A private callback path token is required");
  }
  if (config.allowedUids !== undefined && (!Array.isArray(config.allowedUids) || config.allowedUids.length < 1 ||
      config.allowedUids.length > 100 || config.allowedUids.some(uid => typeof uid !== "string" || !uid || uid.length > 48))) {
    throw new Error("Invalid test user allowlist");
  }
  if (config.runMarker !== undefined && (typeof config.runMarker !== "string" || !config.runMarker || config.runMarker.length > 4096)) {
    throw new Error("Invalid test run marker");
  }
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 3800;
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Only a loopback listener is allowed");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  if (typeof config.evidenceFile !== "string" || !isAbsolute(config.evidenceFile)) {
    throw new Error("An absolute private evidence file is required");
  }
  const failFirst = config.failFirst ?? 0;
  if (!Number.isInteger(failFirst) || failFirst < 0 || failFirst > 3) throw new Error("Invalid test failure count");
  return {...config, mediaKeys: [...mediaKeys], host, port, failFirst};
}

function assertPrivateRegularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("A private regular file is required");
  }
  return stat;
}

export function readConfig(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("A private absolute configuration path is required");
  const stat = assertPrivateRegularFile(path);
  if (stat.size > 16 * 1024) throw new Error("Configuration is too large");
  return validateConfig(JSON.parse(readFileSync(path, "utf8")));
}

function createEvidenceWriter(path) {
  // Refuse existing symlinks; a private directory prevents concurrent replacement.
  try { assertPrivateRegularFile(path); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const fd = openSync(path, "a", 0o600);
  const stat = fstatSync(fd);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    closeSync(fd);
    throw new Error("A private evidence file is required");
  }
  return {
    write(event) { appendFileSync(fd, JSON.stringify(event) + "\n", "utf8"); },
    close() { closeSync(fd); },
  };
}

function equalSecret(left, right) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function seqHash(seq) {
  return createHash("sha256").update(seq).digest("hex").slice(0, 16);
}

function validateEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== FIELD_NAMES.length ||
      FIELD_NAMES.some(field => !Object.hasOwn(body, field))) return false;
  const text = (value, limit, empty = false) => typeof value === "string" &&
    (empty || value.length > 0) && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
  return text(body.seq, 64) && text(body.media, 200) &&
    text(body.adKey, 200) && text(body.adTitle, 2000, true) && text(body.uid, 48) &&
    (body.publisher_data === null || text(body.publisher_data, 4096, true)) &&
    Number.isSafeInteger(body.point) && body.point >= 0;
}

function fingerprint(body) {
  // Fixed field order makes JSON key ordering irrelevant to duplicate detection.
  return createHash("sha256").update(JSON.stringify(FIELD_NAMES.map(field => body[field]))).digest("hex");
}

function readBody(req) {
  return new Promise((fulfill, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.off("data", onData); req.off("end", onEnd); req.off("error", onError); req.off("aborted", onAbort);
    };
    const fail = status => { cleanup(); req.resume(); reject({status}); };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(413);
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); fulfill(Buffer.concat(chunks)); };
    const onError = () => fail(400);
    const onAbort = () => fail(400);
    req.on("data", onData); req.on("end", onEnd); req.on("error", onError); req.on("aborted", onAbort);
  });
}

function reply(res, status, body, close = false) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...(close ? {"Connection": "close"} : {}),
  });
  res.end(JSON.stringify(body));
}

/**
 * A test receiver: it records redacted receipt evidence, never credits real users.
 * Dedupe is process-local and is lost on restart. Use an atomic durable transaction
 * for real credit + seq uniqueness in a production receiver.
 */
export function createPostbackReceiver(input, dependencies = {}) {
  const config = validateConfig(input);
  const writer = dependencies.writeEvidence ? {write: dependencies.writeEvidence, close() {}} :
    createEvidenceWriter(config.evidenceFile);
  const events = new Map();
  const attempts = new Map();
  const callbackPath = "/postback/" + config.pathToken;
  const write = (body, outcome, status, attempt) => writer.write({
    at: new Date().toISOString(), seqHash: seqHash(body.seq),
    mediaIndex: config.mediaKeys.findIndex(key => equalSecret(body.media, key)),
    ...(config.allowedUids ? {uidIndex: config.allowedUids.indexOf(body.uid)} : {}), outcome, status,
    point: body.point, ...(attempt === undefined ? {} : {attempt}),
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/healthz" && req.method === "GET") return reply(res, 200, {ok: true, mode: "test"});
      if (!equalSecret(req.url ?? "", callbackPath)) return reply(res, 404, {error: "not_found"});
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return reply(res, 405, {error: "method_not_allowed"});
      }
      const type = req.headers["content-type"];
      if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(type) ||
          (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) {
        req.resume();
        return reply(res, 415, {error: "unsupported_media_type"}, true);
      }
      const length = req.headers["content-length"];
      if (length && Number(length) > MAX_BODY_BYTES) {
        req.resume();
        return reply(res, 413, {error: "body_too_large"}, true);
      }
      let bytes;
      try { bytes = await readBody(req); }
      catch (error) { return reply(res, error.status === 413 ? 413 : 400, {error: "invalid_body"}, true); }
      let body;
      try { body = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
      catch { return reply(res, 400, {error: "invalid_json"}); }
      if (!validateEvent(body)) return reply(res, 400, {error: "invalid_event"});
      if (!config.mediaKeys.some(key => equalSecret(body.media, key)) ||
          (config.allowedUids && !config.allowedUids.includes(body.uid)) ||
          (config.runMarker !== undefined && body.publisher_data !== config.runMarker)) {
        return reply(res, 403, {error: "event_not_allowed"});
      }
      const digest = fingerprint(body);
      const previous = attempts.get(body.seq);
      if (previous && previous.digest !== digest) {
        write(body, "conflict", 409);
        return reply(res, 409, {error: "seq_conflict"});
      }
      const existing = events.get(body.seq);
      if (existing) {
        if (existing !== digest) {
          write(body, "conflict", 409);
          return reply(res, 409, {error: "seq_conflict"});
        }
        write(body, "duplicate", 200);
        return reply(res, 200, {ok: true, duplicate: true});
      }
      if (events.size >= MAX_EVENTS || (!attempts.has(body.seq) && attempts.size >= MAX_EVENTS)) {
        res.setHeader("Retry-After", "60");
        return reply(res, 503, {error: "test_capacity_reached"});
      }
      const attempt = (previous?.count ?? 0) + 1;
      attempts.set(body.seq, {count: attempt, digest});
      if (attempt <= config.failFirst) {
        write(body, "simulated_failure", 503, attempt);
        res.setHeader("Retry-After", "30");
        return reply(res, 503, {error: "simulated_test_failure"});
      }
      // No await occurs between duplicate check and recording, including concurrent POSTs.
      // Record evidence before acknowledging. Evidence failure keeps this event retryable.
      write(body, "accepted", 200, attempt);
      events.set(body.seq, digest);
      return reply(res, 200, {ok: true, duplicate: false});
    } catch {
      // Never log the raw request, private path, key, uid, or exception/file details.
      if (!res.headersSent) reply(res, 503, {error: "receiver_unavailable"});
      else res.end();
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.on("close", () => writer.close());
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

function main() {
  let config, server;
  try {
    config = readConfig(process.env.GAD_POSTBACK_CONFIG);
    server = createPostbackReceiver(config);
  } catch {
    console.error("[receiver] 시작하지 못했습니다. 비공개 설정 파일과 파일 권한을 확인하세요.");
    process.exitCode = 1;
    return;
  }
  if (config.failFirst > 0) console.warn("[receiver] 테스트 실패 응답 모드가 켜져 있습니다. 운영에 사용하지 마세요.");
  server.on("error", () => {
    console.error("[receiver] 수신기를 시작하지 못했습니다.");
    process.exitCode = 1;
    server.close();
  });
  server.listen(config.port, config.host, () => console.log("[receiver] test receiver listening on loopback port " + config.port));
  const stop = () => {
    server.close(() => { process.exitCode = 0; });
    server.closeIdleConnections();
    const deadline = setTimeout(() => server.closeAllConnections(), 2_000);
    deadline.unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
