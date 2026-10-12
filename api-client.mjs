import {constants, closeSync, fstatSync, ftruncateSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync} from "node:fs";
import {isIP} from "node:net";
import {isAbsolute, resolve} from "node:path";

export const API_BASE_URLS = Object.freeze({
  staging: "https://gad-staging.gpakorea.com",
  production: "https://gad.api.gpakorea.com",
});
export const STAGING_FIXTURE_KEY = "staging-ad-3";
const RESPONSE_LIMIT = 256 * 1024;
const ZERO_ADID = "00000000-0000-0000-0000-000000000000";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const OPERATIONS = Object.freeze({
  list: {method: "GET", path: "/campaign/list", fields: ["adid", "include", "exclude"], required: [], codes: [0]},
  status: {method: "GET", path: "/campaign/status", fields: ["adKey", "adid", "uid"], required: ["adKey", "adid"], codes: [0, 22, 24]},
  join: {method: "POST", path: "/campaign/join", fields: ["adKey", "uid", "adid", "data", "ip"], required: ["adKey", "uid", "adid"], codes: [0]},
  complete: {method: "POST", path: "/campaign/complete", fields: ["adKey", "uid", "adid", "ip"], required: ["adKey", "uid", "adid"], codes: [0, 22, 30]},
  rewards: {method: "GET", path: "/campaign/reward/list", fields: ["uid"], required: ["uid"], codes: [0]},
});

/** Errors intentionally exclude URLs, server messages, request bodies, and original causes. */
export class ApiError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    if (Number.isInteger(details.httpStatus)) this.httpStatus = details.httpStatus;
    if (Number.isSafeInteger(details.resultCode)) this.resultCode = details.resultCode;
  }
}

export function validateClientConfig(input) {
  if (!object(input)) throw new ApiError("invalid_configuration");
  const environment = input.environment ?? "staging";
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (typeof environment !== "string" || !Object.hasOwn(API_BASE_URLS, environment) || !text(input.mediaKey, 200) ||
      (input.allowMutations !== undefined && typeof input.allowMutations !== "boolean") ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      (input.apiBaseUrl !== undefined && input.apiBaseUrl !== API_BASE_URLS[environment])) {
    throw new ApiError("invalid_configuration");
  }
  return {environment, mediaKey: input.mediaKey, timeoutMs, allowMutations: input.allowMutations === true};
}

function validateParameters(operation, parameters) {
  const spec = OPERATIONS[operation];
  if (!spec || !object(parameters) || Object.keys(parameters).some(name => !spec.fields.includes(name))) {
    throw new ApiError("invalid_parameters");
  }
  for (const name of spec.required) if (parameters[name] === undefined) throw new ApiError("invalid_parameters");
  for (const [name, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    const valid = name === "uid" ? text(value, 48) :
      name === "adKey" ? text(value, 200) :
      name === "data" ? text(value, 4096) :
      name === "ip" ? typeof value === "string" && Boolean(isIP(value)) :
      name === "adid" ? text(value, 64) && value !== ZERO_ADID :
      (name === "include" || name === "exclude") && Array.isArray(value) && value.length <= 10 && value.every(type => Number.isInteger(type) && type >= 0 && type <= 9);
    if (!valid) throw new ApiError("invalid_parameters");
  }
  return Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined));
}

export function buildRequest(input, operation, parameters = {}) {
  const config = validateClientConfig(input);
  const values = validateParameters(operation, parameters);
  const spec = OPERATIONS[operation];
  if (spec.method === "POST" && !config.allowMutations) throw new ApiError("mutations_not_enabled");
  const url = new URL(spec.path, API_BASE_URLS[config.environment]);
  const payload = {media: config.mediaKey, ...values};
  if (spec.method === "GET") {
    for (const [name, value] of Object.entries(payload)) {
      if (Array.isArray(value)) for (const type of value) url.searchParams.append(name, String(type));
      else url.searchParams.set(name, value);
    }
  }
  return {url, method: spec.method, ...(spec.method === "POST" ? {body: JSON.stringify(payload)} : {})};
}

async function readJson(response) {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > RESPONSE_LIMIT) {
    await response.body?.cancel().catch(() => {});
    throw new ApiError("response_too_large");
  }
  if (!response.body) throw new ApiError("invalid_api_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", {fatal: true});
  let raw = "", bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_LIMIT) {
        await reader.cancel().catch(() => {});
        throw new ApiError("response_too_large");
      }
      raw += decoder.decode(chunk.value, {stream: true});
    }
    raw += decoder.decode();
    const data = JSON.parse(raw);
    if (!object(data) || !Number.isSafeInteger(data.code)) throw new ApiError("invalid_api_response");
    return data;
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError("invalid_api_response");
  } finally { reader.releaseLock(); }
}

function validateResponse(operation, data, httpStatus, parameters) {
  if (!OPERATIONS[operation].codes.includes(data.code)) throw new ApiError("api_result_error", {httpStatus, resultCode: data.code});
  // Status 22/24 and repeated completion 22/30 are business outcomes, not HTTP failures.
  if (data.code !== 0) return;
  const valid = operation === "list" || operation === "rewards" ? Array.isArray(data.items) :
    operation === "join" ? object(data.join) && text(data.join.id, 200) && (data.join.url === undefined || typeof data.join.url === "string") :
    operation === "complete" ? object(data.reward) && text(data.reward.id, 200) && data.reward.uid === parameters.uid && Number.isSafeInteger(data.reward.reward_point) && data.reward.reward_point >= 0 : true;
  if (!valid) throw new ApiError("invalid_api_response");
}

/** No logging or automatic retries. Returned data may contain personal information. */
export function createClient(input, dependencies = {}) {
  const config = validateClientConfig(input);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new ApiError("invalid_configuration");
  async function call(operation, parameters = {}) {
    const request = buildRequest(config, operation, parameters);
    const controller = new AbortController();
    let deadline;
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => {
        reject(new ApiError("request_timeout"));
        controller.abort();
      }, config.timeoutMs);
    });
    const perform = async () => {
      let response;
      try {
        response = await fetchImpl(request.url, {
          method: request.method, redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal,
          headers: {Accept: "application/json", ...(request.body ? {"Content-Type": "application/json"} : {})},
          ...(request.body ? {body: request.body} : {}),
        });
      } catch { throw new ApiError(controller.signal.aborted ? "request_timeout" : "request_failed"); }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new ApiError("unexpected_http_status", {httpStatus: response.status});
      }
      const data = await readJson(response);
      validateResponse(operation, data, response.status, parameters);
      return {environment: config.environment, operation, httpStatus: response.status, resultCode: data.code, data};
    };
    try { return await Promise.race([perform(), timeout]); }
    catch (error) { throw error instanceof ApiError ? error : new ApiError("request_failed"); }
    finally { clearTimeout(deadline); }
  }
  return Object.freeze(Object.fromEntries(Object.keys(OPERATIONS).map(operation => [operation, parameters => call(operation, parameters)])));
}

export function readPrivateJson(path) {
  let fd;
  try {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error();
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1 || (process.platform !== "win32" && (before.mode & 0o077))) throw new Error();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error();
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch { throw new ApiError("invalid_private_configuration"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function writePrivateResult(path, result) {
  let fd;
  try {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error();
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.nlink !== 1 || (process.platform !== "win32" && (existing.mode & 0o077))) throw new Error();
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error();
    const data = Buffer.from(JSON.stringify(result, null, 2) + "\n");
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset, offset);
    ftruncateSync(fd, data.length);
    fsyncSync(fd);
  } catch { throw new ApiError("private_result_write_failed"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function assertSeparateFiles(configPath, resultPath) {
  if (typeof resultPath !== "string" || !isAbsolute(resultPath) || resolve(configPath) === resolve(resultPath)) {
    throw new ApiError("invalid_configuration");
  }
}
