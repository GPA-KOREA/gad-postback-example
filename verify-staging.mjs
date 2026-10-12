import {constants, closeSync, fstatSync, ftruncateSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync} from "node:fs";
import {isIP} from "node:net";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

export const STAGING_API_BASE = "https://gad-staging.gpakorea.com";
export const FIXTURE_KEY = "staging-ad-3";
const RESPONSE_LIMIT = 256 * 1024;
const ENDPOINTS = new Set(["/campaign/list", "/campaign/join", "/campaign/complete", "/campaign/reward/list", "/campaign/status"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);

export class VerificationError extends Error {
  constructor(code, phase = "configuration", caseNumber) {
    super(code);
    this.code = code;
    this.phase = phase;
    this.caseNumber = caseNumber;
  }
}

export function validateConfig(input) {
  const fail = () => { throw new VerificationError("invalid_configuration"); };
  if (!object(input)) fail();
  // This verifier cannot be redirected to production or an arbitrary API server.
  if (input.apiBaseUrl !== undefined && input.apiBaseUrl !== STAGING_API_BASE) fail();
  if (!Array.isArray(input.media) || input.media.length < 1 || input.media.length > 10) fail();
  if (!text(input.runMarker, 4096)) fail();
  if (typeof input.receiverEvidenceFile !== "string" || !isAbsolute(input.receiverEvidenceFile)) fail();
  const rawResultsFile = input.privateResultFile ?? input.rawResultsFile;
  if (rawResultsFile !== undefined && (typeof rawResultsFile !== "string" || !isAbsolute(rawResultsFile))) fail();
  if (input.privateResultFile && input.rawResultsFile && resolve(input.privateResultFile) !== resolve(input.rawResultsFile)) fail();
  if (rawResultsFile && resolve(rawResultsFile) === resolve(input.receiverEvidenceFile)) fail();
  if (input.waitForReceipt !== undefined && typeof input.waitForReceipt !== "boolean") fail();
  const receiptTimeoutMs = input.receiptTimeoutMs ?? 120_000;
  if (!Number.isInteger(receiptTimeoutMs) || receiptTimeoutMs < 1_000 || receiptTimeoutMs > 300_000) fail();
  const media = input.media.map(item => {
    if (!object(item) || !text(item.key, 200) || !text(item.uid, 48) ||
        typeof item.adid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.adid) ||
        item.adid === "00000000-0000-0000-0000-000000000000" ||
        (item.ip !== undefined && (typeof item.ip !== "string" || !isIP(item.ip))) ||
        (item.label !== undefined && !text(item.label, 64))) fail();
    return {key: item.key, uid: item.uid, adid: item.adid, ...(item.ip ? {ip: item.ip} : {})};
  });
  if (new Set(media.map(item => item.key)).size !== media.length ||
      new Set(media.map(item => item.uid)).size !== media.length ||
      new Set(media.map(item => item.adid.toLowerCase())).size !== media.length) fail();
  return {...input, rawResultsFile, media, receiptTimeoutMs, waitForReceipt: input.waitForReceipt !== false};
}

function readPrivateFile(path, limit) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new VerificationError("invalid_private_file");
  let fd;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || (process.platform !== "win32" && (before.mode & 0o077))) throw new Error();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error();
    return readFileSync(fd, "utf8");
  } catch { throw new VerificationError("invalid_private_file"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readConfig(path) {
  let input;
  try { input = JSON.parse(readPrivateFile(path, 16 * 1024)); }
  catch { throw new VerificationError("invalid_configuration"); }
  const config = validateConfig(input);
  const rawResultsFile = config.rawResultsFile ?? join(dirname(path), "staging-verification-private.json");
  if ([path, config.receiverEvidenceFile].some(value => resolve(value) === resolve(rawResultsFile))) {
    throw new VerificationError("invalid_configuration");
  }
  return {...config, rawResultsFile};
}

export function readReceiptEvidence(path) {
  try { return parseReceiptEvidence(readPrivateFile(path, 2 * 1024 * 1024)); }
  catch (error) {
    // Missing evidence before the receiver has written its first line is normal.
    try { lstatSync(path); } catch (missing) { if (missing.code === "ENOENT") return []; }
    throw new VerificationError("invalid_receiver_evidence", "receipt");
  }
}

export function parseReceiptEvidence(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 2 * 1024 * 1024) {
    throw new VerificationError("invalid_receiver_evidence", "receipt");
  }
  const lines = raw.split("\n");
  if (lines.at(-1) !== "") lines.pop(); // A writer may still be appending its final line.
  const events = [];
  for (const line of lines.filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new VerificationError("invalid_receiver_evidence", "receipt"); }
    if (!object(event) || !/^[a-f0-9]{16}$/.test(event.seqHash) ||
        !Number.isInteger(event.mediaIndex) || event.mediaIndex < 0 || event.mediaIndex > 9 ||
        !Number.isInteger(event.uidIndex) || event.uidIndex < 0 || event.uidIndex > 99 || !Number.isSafeInteger(event.point) || event.point < 0 ||
        !Number.isInteger(event.status) || !["accepted", "duplicate", "simulated_failure", "conflict"].includes(event.outcome)) {
      throw new VerificationError("invalid_receiver_evidence", "receipt");
    }
    events.push(event);
  }
  return events;
}

export function stageUrl(endpoint, parameters = {}) {
  if (!ENDPOINTS.has(endpoint)) throw new VerificationError("invalid_api_scope");
  const url = new URL(endpoint, STAGING_API_BASE);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url;
}

async function readJson(response, phase, caseNumber) {
  let bytes = 0, raw = "";
  try {
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", {fatal: true});
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > RESPONSE_LIMIT) { await reader.cancel(); throw new Error(); }
        raw += decoder.decode(chunk.value, {stream: true});
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
    const body = JSON.parse(raw);
    if (!object(body)) throw new Error();
    return body;
  } catch { throw new VerificationError("invalid_api_response", phase, caseNumber); }
}

/** Pure dependency injection keeps tests from using real APIs, databases, or receiver files. */
export async function runVerification(input, dependencies = {}) {
  const config = validateConfig(input);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const readEvidence = dependencies.readEvidence ?? (() => readReceiptEvidence(config.receiverEvidenceFile));
  const writePrivate = dependencies.writePrivate ?? (() => {});
  const sleep = dependencies.sleep ?? (ms => new Promise(fulfill => setTimeout(fulfill, ms)));
  const now = dependencies.now ?? Date.now;
  const privateResults = {scope: "staging-api-cron-webhook", startedAt: new Date(now()).toISOString(), responses: [], cases: []};
  const publicResults = [];
  const consumedSeqHashes = new Set();
  const persist = () => {
    try { writePrivate(privateResults); }
    catch { throw new VerificationError("private_results_write_failed"); }
  };
  persist();
  async function call(phase, caseNumber, method, endpoint, query, body) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      let response;
      try {
        response = await fetchImpl(stageUrl(endpoint, query), {
          method, redirect: "manual", signal: controller.signal,
          headers: {Accept: "application/json", ...(body ? {"Content-Type": "application/json"} : {})},
          ...(body ? {body: JSON.stringify(body)} : {}),
        });
      } catch { throw new VerificationError("api_request_failed", phase, caseNumber); }
      // Redirect bodies/locations can contain credentials. Do not follow, log, or retain them.
      if (response.status !== 200) throw new VerificationError("unexpected_http_status", phase, caseNumber);
      const json = await readJson(response, phase, caseNumber);
      privateResults.responses.push({case: caseNumber, phase, method, endpoint, response: json});
      persist();
      return json;
    } finally { clearTimeout(deadline); }
  }
  const assert = (condition, phase, caseNumber) => {
    if (!condition) throw new VerificationError("verification_failed", phase, caseNumber);
  };
  try {
    for (const [index, media] of config.media.entries()) {
      const caseNumber = index + 1;
      const baseline = new Set(readEvidence().map(event => event.seqHash));
      const listing = await call("list", caseNumber, "GET", "/campaign/list", {media: media.key});
      const matches = Array.isArray(listing.items) ? listing.items.filter(item => item?.key === FIXTURE_KEY) : [];
      assert(listing.code === 0 && matches.length === 1 && matches[0].type === 1 && matches[0].subtype === "CPI", "list", caseNumber);
      const request = {media: media.key, adKey: FIXTURE_KEY, uid: media.uid, adid: media.adid, ...(media.ip ? {ip: media.ip} : {})};
      const joined = await call("join", caseNumber, "POST", "/campaign/join", {}, {...request, data: config.runMarker});
      assert(joined.code === 0 && object(joined.join) && text(joined.join.id, 64), "join", caseNumber);
      // This calls only the staging CPI fixture; it does not verify an actual app installation.
      const completed = await call("complete", caseNumber, "POST", "/campaign/complete", {}, request);
      const reward = completed.reward;
      assert(completed.code === 0 && object(reward) && text(reward.id, 64) && reward.uid === media.uid &&
        Number.isSafeInteger(reward.reward_point) && reward.reward_point >= 0, "complete", caseNumber);
      const rewards = await call("rewards", caseNumber, "GET", "/campaign/reward/list", {media: media.key, uid: media.uid});
      assert(rewards.code === 0 && Array.isArray(rewards.items) && rewards.items.length === 1 &&
        rewards.items[0].id === reward.id && rewards.items[0].uid === media.uid &&
        rewards.items[0].reward_point === reward.reward_point && rewards.items[0].advertisement?.key === FIXTURE_KEY, "rewards", caseNumber);
      const status = await call("status", caseNumber, "GET", "/campaign/status", request);
      assert(status.code === 22, "status", caseNumber);
      let receipt = null, receiptEvents = [];
      if (config.waitForReceipt) {
        const until = now() + config.receiptTimeoutMs;
        do {
          receiptEvents = readEvidence().filter(event => !baseline.has(event.seqHash) && !consumedSeqHashes.has(event.seqHash) &&
            event.mediaIndex === index && event.uidIndex === index && event.point === reward.reward_point);
          receipt = receiptEvents.find(event => event.status === 200 && event.outcome === "accepted");
          if (receipt) {
            receiptEvents = receiptEvents.filter(event => event.seqHash === receipt.seqHash);
            break;
          }
          if (now() >= until) throw new VerificationError("receiver_confirmation_timed_out", "receipt", caseNumber);
          await sleep(Math.min(1_000, Math.max(1, until - now())));
        } while (true);
        consumedSeqHashes.add(receipt.seqHash);
      }
      privateResults.cases.push({case: caseNumber, joinId: joined.join.id, rewardId: reward.id, receiptEvents});
      publicResults.push({case: caseNumber, apiVerified: true, webhookVerified: Boolean(receipt),
        point: reward.reward_point, ...(receipt ? {receiverAttempts: receiptEvents.length, receiverStatus: 200} : {})});
      persist();
    }
    return {ok: true, scope: "staging-api-cron-webhook", nativeSdkVerified: false, realAppInstallationVerified: false,
      webhookVerified: publicResults.every(result => result.webhookVerified), cases: publicResults};
  } catch (error) {
    const safe = error instanceof VerificationError ? error : new VerificationError("verification_failed");
    privateResults.failure = {code: safe.code, phase: safe.phase, ...(safe.caseNumber ? {case: safe.caseNumber} : {})};
    persist();
    throw safe;
  }
}

function privateWriter(path) {
  let fd;
  try {
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || (process.platform !== "win32" && (existing.mode & 0o077))) throw new Error();
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error();
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new VerificationError("private_results_write_failed");
  }
  return {
    write(results) {
      const data = Buffer.from(JSON.stringify(results, null, 2) + "\n");
      // Explicit positions avoid appending stale response data when updating this private file.
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset, offset);
      ftruncateSync(fd, data.length);
      fsyncSync(fd);
    },
    close() { closeSync(fd); },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let writer;
  try {
    if (argv.length !== 1 || argv[0] !== "--verify-staging-postback") throw new VerificationError("explicit_staging_flag_required");
    const config = readConfig(env.GAD_STAGING_VERIFY_CONFIG);
    writer = privateWriter(config.rawResultsFile);
    const result = await runVerification(config, {writePrivate: value => writer.write(value)});
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    const safe = error instanceof VerificationError ? error : new VerificationError("verification_failed");
    console.error(JSON.stringify({ok: false, code: safe.code, phase: safe.phase, ...(safe.caseNumber ? {case: safe.caseNumber} : {})}));
    return 1;
  } finally { writer?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
