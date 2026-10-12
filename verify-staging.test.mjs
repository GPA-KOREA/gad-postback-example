import test from "node:test";
import assert from "node:assert/strict";
import {chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FIXTURE_KEY, STAGING_API_BASE, main, parseReceiptEvidence, readConfig, readReceiptEvidence, runVerification, stageUrl, validateConfig} from "./verify-staging.mjs";

const SECRET_KEY = "private-media-key-never-print";
const SECRET_UID = "private-user-never-print";
const MARKER = "private-run-marker-never-print";
function config(count = 1) {
  return {
    media: Array.from({length: count}, (_, index) => ({key: SECRET_KEY + index, uid: SECRET_UID + index,
      adid: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`, label: `Case ${index + 1}`})),
    runMarker: MARKER, receiverEvidenceFile: "/private/test-receipts.jsonl", receiptTimeoutMs: 1000,
  };
}
function receipt(index = 0, patch = {}) {
  return {seqHash: String(index + 1).padStart(16, "a"), mediaIndex: index, uidIndex: index,
    outcome: "accepted", status: 200, point: 5, attempt: 1, ...patch};
}
function apiFixture(input, options = {}) {
  const calls = [], events = [];
  const json = value => new Response(JSON.stringify(value), {headers: {"Content-Type": "application/json"}});
  async function fetch(url, request) {
    assert.equal(url.origin, STAGING_API_BASE);
    assert.equal(request.redirect, "manual");
    assert.ok(request.signal instanceof AbortSignal);
    const body = request.body ? JSON.parse(request.body) : null;
    const key = body?.media ?? url.searchParams.get("media");
    const index = input.media.findIndex(item => item.key === key);
    assert.ok(index >= 0);
    calls.push({path: url.pathname, method: request.method, body, query: Object.fromEntries(url.searchParams)});
    if (options.override) {
      const response = options.override(url, request, body, index);
      if (response) return response;
    }
    if (url.pathname === "/campaign/list") return json({code: 0, items: [
      {key: "staging-ad-1", type: 3}, {key: FIXTURE_KEY, type: 1, subtype: "CPI", point: 5},
      {key: "staging-ad-4", type: 5}, {key: "staging-ad-2", type: 0},
    ]});
    if (url.pathname === "/campaign/join") return json({code: 0, join: {id: `join-${index}`, url: "https://example.com/staging/unused"}});
    const reward = {id: `reward-${index}`, uid: input.media[index].uid, reward_point: 5,
      advertisement: {key: FIXTURE_KEY}};
    if (url.pathname === "/campaign/complete") {
      if (!options.noReceipt) events.push(receipt(index));
      return json({code: 0, reward});
    }
    if (url.pathname === "/campaign/reward/list") return json({code: 0, items: [reward]});
    if (url.pathname === "/campaign/status") return json({code: 22});
    assert.fail("Unexpected fixture request");
  }
  return {fetch, calls, events, json};
}
function clock() {
  let current = 0;
  return {now: () => current, sleep: async milliseconds => { current += milliseconds; }};
}

test("configuration fixes the API scope, rejects production and duplicate device IDs", () => {
  assert.equal(validateConfig(config()).media.length, 1);
  for (const apiBaseUrl of ["https://gad.api.gpakorea.com", "https://gad-staging.gpakorea.com/", "http://gad-staging.gpakorea.com",
    "https://user:password@gad-staging.gpakorea.com", "https://gad-staging.gpakorea.com:444", "https://gad-staging.gpakorea.com?media=secret"]) {
    assert.throws(() => validateConfig({...config(), apiBaseUrl}), /invalid_configuration/);
  }
  assert.equal(validateConfig({...config(), apiBaseUrl: STAGING_API_BASE}).apiBaseUrl, STAGING_API_BASE);
  const two = config(2); two.media[1].adid = two.media[0].adid;
  assert.throws(() => validateConfig(two), /invalid_configuration/);
  const repeatedKey = config(2); repeatedKey.media[1].key = repeatedKey.media[0].key;
  assert.throws(() => validateConfig(repeatedKey), /invalid_configuration/);
  const repeatedUid = config(2); repeatedUid.media[1].uid = repeatedUid.media[0].uid;
  assert.throws(() => validateConfig(repeatedUid), /invalid_configuration/);
});

test("configuration refuses malformed IDs, unbounded polling, and shared output files", () => {
  for (const patch of [{uid: "x".repeat(49)}, {adid: "00000000-0000-0000-0000-000000000000"},
    {adid: "not-a-device-id"}, {ip: "127.0.0.1@outside.test"}, {key: "secret\nvalue"}]) {
    const input = config(); Object.assign(input.media[0], patch);
    assert.throws(() => validateConfig(input), /invalid_configuration/);
  }
  for (const patch of [{receiptTimeoutMs: 300001}, {waitForReceipt: "false"}, {receiverEvidenceFile: "relative"},
    {rawResultsFile: "/private/test-receipts.jsonl"}, {privateResultFile: "/one", rawResultsFile: "/two"}]) {
    assert.throws(() => validateConfig({...config(), ...patch}), /invalid_configuration/);
  }
});

test("stageUrl only permits the five fixed paths and encodes private query values", () => {
  const url = stageUrl("/campaign/list", {media: "a&b?c"});
  assert.equal(url.origin, STAGING_API_BASE);
  assert.equal(url.searchParams.get("media"), "a&b?c");
  for (const path of ["https://gad.api.gpakorea.com/campaign/join", "//evil.test", "/campaign/action", "/campaign/complete?adKey=real"]) {
    assert.throws(() => stageUrl(path), /invalid_api_scope/);
  }
});

test("four cases verify API state and correlated receiver evidence without printing identities", async () => {
  const input = config(4), api = apiFixture(input), privateSnapshots = [];
  const result = await runVerification(input, {fetch: api.fetch, readEvidence: () => api.events,
    writePrivate: value => privateSnapshots.push(JSON.parse(JSON.stringify(value))), ...clock()});
  assert.equal(result.ok, true);
  assert.equal(result.webhookVerified, true);
  assert.equal(result.nativeSdkVerified, false);
  assert.equal(result.realAppInstallationVerified, false);
  assert.equal(result.cases.length, 4);
  assert.equal(api.calls.length, 20);
  for (let index = 0; index < 4; index++) {
    const calls = api.calls.slice(index * 5, index * 5 + 5);
    assert.deepEqual(calls.map(call => [call.path, call.method]), [
      ["/campaign/list", "GET"], ["/campaign/join", "POST"], ["/campaign/complete", "POST"],
      ["/campaign/reward/list", "GET"], ["/campaign/status", "GET"],
    ]);
    assert.equal(calls[1].body.data, MARKER);
    assert.equal(calls[1].body.adKey, FIXTURE_KEY);
    assert.equal(calls[2].body.data, undefined);
    assert.equal(calls[2].body.uid, input.media[index].uid);
  }
  const publicJson = JSON.stringify(result);
  for (const secret of [SECRET_KEY, SECRET_UID, MARKER, "join-0", "reward-0", "aaaaaaaaaaaaaaa1"]) assert.ok(!publicJson.includes(secret));
  const privateJson = JSON.stringify(privateSnapshots.at(-1));
  assert.ok(privateJson.includes(SECRET_UID));
  assert.ok(privateJson.includes("reward-0"));
  assert.equal(privateSnapshots.at(-1).responses.length, 20);
});

test("a failure then 200 receipt must be for the same case and counts both attempts", async () => {
  const input = config(), api = apiFixture(input, {noReceipt: true});
  let evidenceReads = 0;
  const first = receipt(0, {outcome: "simulated_failure", status: 503, attempt: 1});
  const second = receipt(0, {attempt: 2});
  const result = await runVerification(input, {fetch: api.fetch, ...clock(), readEvidence: () => {
    evidenceReads++;
    return evidenceReads === 1 ? [] : evidenceReads === 2 ? [first] : [first, second];
  }});
  assert.equal(result.cases[0].receiverAttempts, 2);
  assert.equal(result.cases[0].receiverStatus, 200);
});

test("receiver attempt count excludes other new seq hashes for the same user and media", async () => {
  const input = config(), api = apiFixture(input, {noReceipt: true}), snapshots = [];
  let firstRead = true;
  const unrelated = receipt(0, {seqHash: "bbbbbbbbbbbbbbbb", outcome: "simulated_failure", status: 503});
  const failed = receipt(0, {outcome: "simulated_failure", status: 503, attempt: 1});
  const accepted = receipt(0, {attempt: 2});
  const result = await runVerification(input, {fetch: api.fetch, ...clock(),
    writePrivate: value => snapshots.push(JSON.parse(JSON.stringify(value))), readEvidence: () => {
      if (firstRead) { firstRead = false; return []; }
      return [unrelated, failed, accepted];
    }});
  assert.equal(result.cases[0].receiverAttempts, 2);
  assert.equal(snapshots.at(-1).cases[0].receiptEvents.length, 2);
  assert.ok(snapshots.at(-1).cases[0].receiptEvents.every(event => event.seqHash === accepted.seqHash));
});

test("unrelated, stale, wrong amount, duplicate-only, or non-200 evidence cannot confirm a webhook", async () => {
  for (const wrong of [receipt(1), receipt(0, {uidIndex: 1}), receipt(0, {point: 6}),
    receipt(0, {outcome: "duplicate"}), receipt(0, {status: 503})]) {
    const input = config(), api = apiFixture(input, {noReceipt: true});
    let firstRead = true;
    await assert.rejects(runVerification(input, {fetch: api.fetch, ...clock(), readEvidence: () => {
      if (firstRead) { firstRead = false; return []; }
      return [wrong];
    }}), /receiver_confirmation_timed_out/);
  }
  const input = config(), api = apiFixture(input, {noReceipt: true});
  await assert.rejects(runVerification(input, {fetch: api.fetch, ...clock(), readEvidence: () => [receipt()]}), /receiver_confirmation_timed_out/);
});

test("manual receiver confirmation is represented explicitly without claiming success", async () => {
  const input = {...config(), waitForReceipt: false}, api = apiFixture(input, {noReceipt: true});
  const result = await runVerification(input, {fetch: api.fetch, readEvidence: () => [], ...clock()});
  assert.equal(result.ok, true);
  assert.equal(result.webhookVerified, false);
  assert.equal(result.cases[0].webhookVerified, false);
});

test("wrong fixture type or key aborts before any participation mutation", async () => {
  for (const item of [{key: FIXTURE_KEY, type: 0, subtype: "VWI"}, {key: "real-ad", type: 1, subtype: "CPI"}]) {
    const input = config(), api = apiFixture(input, {override: url => url.pathname.endsWith("/list") ?
      new Response(JSON.stringify({code: 0, items: [item]})) : null});
    await assert.rejects(runVerification(input, {fetch: api.fetch, readEvidence: () => []}), error => error.phase === "list");
    assert.equal(api.calls.length, 1);
  }
});

test("failed join is not retried and complete is never invoked", async () => {
  const input = config(), api = apiFixture(input, {override: url => url.pathname === "/campaign/join" ?
    new Response(JSON.stringify({code: 22, message: SECRET_KEY})) : null});
  await assert.rejects(runVerification(input, {fetch: api.fetch, readEvidence: () => []}), error => {
    assert.equal(error.phase, "join"); assert.ok(!error.message.includes(SECRET_KEY)); return true;
  });
  assert.equal(api.calls.length, 2);
});

test("reward identity, amount, count, and completed status are asserted", async () => {
  const cases = [
    ["/campaign/complete", {code: 0, reward: {id: "r", uid: "wrong-user", reward_point: 5}}, "complete"],
    ["/campaign/reward/list", {code: 0, items: []}, "rewards"],
    ["/campaign/reward/list", {code: 0, items: [{id: "reward-0", uid: SECRET_UID + "0", reward_point: 6, advertisement: {key: FIXTURE_KEY}}]}, "rewards"],
    ["/campaign/status", {code: 0}, "status"],
  ];
  for (const [path, response, phase] of cases) {
    const input = config(), api = apiFixture(input, {override: url => url.pathname === path ? new Response(JSON.stringify(response)) : null});
    await assert.rejects(runVerification(input, {fetch: api.fetch, readEvidence: () => []}), error => error.phase === phase);
  }
});

test("redirects, network exception text, oversized bodies, and invalid JSON never escape as credentials", async () => {
  for (const fetch of [
    async () => new Response(null, {status: 302, headers: {Location: `https://gad.api.gpakorea.com?secret=${SECRET_KEY}`}}),
    async () => { throw new Error(SECRET_KEY); },
    async () => new Response("x".repeat(256 * 1024 + 1)),
    async () => new Response(SECRET_KEY),
  ]) {
    let calls = 0;
    await assert.rejects(runVerification(config(), {fetch: (...args) => { calls++; return fetch(...args); }, readEvidence: () => []}), error => {
      assert.ok(!error.message.includes(SECRET_KEY)); assert.ok(!JSON.stringify(error).includes(SECRET_KEY)); return true;
    });
    assert.equal(calls, 1);
  }
});

test("receiver evidence parser requires the redacted correlation contract", () => {
  assert.equal(parseReceiptEvidence(JSON.stringify(receipt()) + "\n").length, 1);
  assert.equal(parseReceiptEvidence(JSON.stringify(receipt())).length, 0);
  for (const event of [{...receipt(), uidIndex: undefined}, {...receipt(), seqHash: "raw-seq"}, {...receipt(), outcome: "unknown"}]) {
    assert.throws(() => parseReceiptEvidence(JSON.stringify(event) + "\n"), /invalid_receiver_evidence/);
  }
});

test("private configuration and evidence files reject public permissions and symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "gad-verifier-test-"));
  try {
    const path = join(directory, "config.json"), evidence = join(directory, "receipt.jsonl");
    writeFileSync(path, JSON.stringify({...config(), receiverEvidenceFile: evidence, privateResultFile: join(directory, "private.json")}), {mode: 0o600});
    writeFileSync(evidence, JSON.stringify(receipt()) + "\n", {mode: 0o600});
    assert.equal(readConfig(path).rawResultsFile, join(directory, "private.json"));
    assert.equal(readReceiptEvidence(evidence).length, 1);
    assert.deepEqual(readReceiptEvidence(join(directory, "missing.jsonl")), []);
    if (process.platform !== "win32") {
      chmodSync(path, 0o644); assert.throws(() => readConfig(path), /invalid_configuration/); chmodSync(path, 0o600);
    }
    symlinkSync(path, join(directory, "link.json"));
    assert.throws(() => readConfig(join(directory, "link.json")), /invalid_configuration/);
    const same = {...config(), receiverEvidenceFile: evidence, privateResultFile: path};
    writeFileSync(path, JSON.stringify(same));
    assert.throws(() => readConfig(path), /invalid_configuration/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test("CLI refuses implicit execution without reading credentials or making a request", async () => {
  const messages = [], original = console.error;
  console.error = message => messages.push(message);
  try {
    assert.equal(await main([], {}), 1);
    assert.deepEqual(JSON.parse(messages[0]), {ok: false, code: "explicit_staging_flag_required", phase: "configuration"});
  } finally { console.error = original; }
});

test("CLI writes valid private JSON snapshots and prints only the redacted result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gad-verifier-cli-test-"));
  const originalFetch = globalThis.fetch, originalLog = console.log, originalError = console.error, messages = [];
  try {
    const evidence = join(directory, "receipts.jsonl"), path = join(directory, "config.json"), rawResults = join(directory, "results.json");
    const input = {...config(), receiverEvidenceFile: evidence, privateResultFile: rawResults};
    const api = apiFixture(input);
    writeFileSync(path, JSON.stringify(input), {mode: 0o600});
    globalThis.fetch = async (...args) => {
      const response = await api.fetch(...args);
      writeFileSync(evidence, api.events.map(event => JSON.stringify(event) + "\n").join(""), {mode: 0o600});
      return response;
    };
    console.log = message => messages.push(message); console.error = message => messages.push(message);
    assert.equal(await main(["--verify-staging-postback"], {GAD_STAGING_VERIFY_CONFIG: path}), 0);
    assert.equal(messages.length, 1);
    assert.equal(JSON.parse(messages[0]).webhookVerified, true);
    assert.ok(!messages[0].includes(SECRET_KEY)); assert.ok(!messages[0].includes(SECRET_UID));
    const saved = JSON.parse(readFileSync(rawResults, "utf8"));
    assert.equal(saved.responses.length, 5); assert.equal(saved.cases.length, 1);
    if (process.platform !== "win32") assert.equal(statSync(rawResults).mode & 0o077, 0);
  } finally {
    globalThis.fetch = originalFetch; console.log = originalLog; console.error = originalError;
    rmSync(directory, {recursive: true, force: true});
  }
});
