import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {createHash} from "node:crypto";
import {mkdtempSync, readFileSync, writeFileSync, chmodSync, statSync, symlinkSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createPostbackReceiver, readConfig, MAX_BODY_BYTES} from "./server.mjs";

const MEDIA_KEY = "00000000-1111-4222-8333-444444444444";
const PATH_TOKEN = "synthetic_test_token_" + "x".repeat(32);
const BODY = {
  seq: "synthetic-seq-001", media: MEDIA_KEY, adKey: "synthetic-ad-001",
  adTitle: "Synthetic test advertisement", uid: "synthetic-user-001",
  publisher_data: "synthetic-run-marker", point: 5,
};
const config = overrides => ({
  mediaKeys: [MEDIA_KEY], pathToken: PATH_TOKEN, port: 3800,
  evidenceFile: join(tmpdir(), "unused-by-injected-test-writer.jsonl"), ...overrides,
});

async function fixture(t, overrides = {}, sink) {
  const evidence = [];
  const server = createPostbackReceiver(config(overrides), {writeEvidence: sink ?? (event => evidence.push(event))});
  await new Promise((fulfill, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", fulfill);
  });
  t.after(async () => {
    const closed = new Promise(fulfill => server.close(fulfill));
    server.closeAllConnections();
    await closed;
  });
  const port = server.address().port;
  const request = (body = BODY, options = {}) => new Promise((fulfill, reject) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const headers = {"Content-Type": "application/json", ...options.headers};
    if (!options.chunked) headers["Content-Length"] = bytes.length;
    const req = http.request({
      hostname: "127.0.0.1", port, method: options.method ?? "POST",
      path: options.path ?? "/postback/" + PATH_TOKEN, headers,
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => fulfill({
        status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8"),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    req.on("error", reject);
    if (options.chunked) {
      req.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      req.end(bytes.subarray(Math.floor(bytes.length / 2)));
    } else req.end(bytes);
  });
  return {server, request, evidence};
}

test("accepts the seven-field GAD event and acknowledges exactly HTTP 200", async t => {
  const {request, evidence} = await fixture(t);
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {ok: true, duplicate: false});
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].seqHash, createHash("sha256").update(BODY.seq).digest("hex").slice(0, 16));
  assert.equal(evidence[0].outcome, "accepted");
  assert.equal(evidence[0].mediaIndex, 0);
  assert.equal(evidence[0].point, BODY.point);
  const serialized = JSON.stringify({evidence, response: response.body});
  for (const secret of [BODY.seq, MEDIA_KEY, PATH_TOKEN, BODY.uid, BODY.adKey, BODY.adTitle, BODY.publisher_data]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("same seq and semantic payload returns 200 without a second acceptance", async t => {
  const {request, evidence} = await fixture(t);
  await request();
  const reordered = Object.fromEntries(Object.entries(BODY).reverse());
  const response = await request(reordered);
  assert.equal(response.status, 200);
  assert.equal(response.body.duplicate, true);
  assert.deepEqual(evidence.map(event => event.outcome), ["accepted", "duplicate"]);
});

test("20 concurrent duplicate deliveries accept once", async t => {
  const {request, evidence} = await fixture(t);
  const responses = await Promise.all(Array.from({length: 20}, () => request()));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(responses.filter(response => response.body.duplicate === false).length, 1);
  assert.equal(evidence.filter(event => event.outcome === "accepted").length, 1);
});

test("same seq with changed content is a 409 conflict", async t => {
  const {request, evidence} = await fixture(t);
  await request();
  const response = await request({...BODY, point: BODY.point + 1});
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {error: "seq_conflict"});
  assert.deepEqual(evidence.map(event => event.outcome), ["accepted", "conflict"]);
});

test("rejects other media, test users, or run markers before recording", async t => {
  const {request, evidence} = await fixture(t, {allowedUids: [BODY.uid], runMarker: BODY.publisher_data});
  for (const body of [
    {...BODY, media: "other-media-key"}, {...BODY, uid: "other-user"},
    {...BODY, publisher_data: "other-run"}, {...BODY, publisher_data: null},
  ]) assert.equal((await request(body)).status, 403);
  assert.deepEqual(evidence, []);
  assert.equal((await request()).status, 200);
  assert.equal(evidence[0].uidIndex, 0);
});

test("receipt indexes identify each configured media and synthetic user without raw values", async t => {
  const keys = Array.from({length: 4}, (_, index) => "synthetic-media-" + index);
  const users = Array.from({length: 4}, (_, index) => "synthetic-user-" + index);
  const {request, evidence} = await fixture(t, {mediaKeys: keys, allowedUids: users});
  for (let index = 0; index < 4; index++) {
    const response = await request({...BODY, seq: "synthetic-seq-" + index, media: keys[index], uid: users[index]});
    assert.equal(response.status, 200);
  }
  assert.deepEqual(evidence.map(event => [event.mediaIndex, event.uidIndex]), [[0, 0], [1, 1], [2, 2], [3, 3]]);
  for (const secret of [...keys, ...users]) assert.equal(JSON.stringify(evidence).includes(secret), false);
});

test("unknown path, path query, and wrong method never disclose the secret path", async t => {
  const {request, evidence} = await fixture(t);
  for (const path of ["/", "/postback/wrong", "/postback/" + PATH_TOKEN + "?debug=1"]) {
    const response = await request(BODY, {path});
    assert.equal(response.status, 404);
    assert.equal(response.text.includes(PATH_TOKEN), false);
  }
  const wrongMethod = await request(BODY, {method: "GET"});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST");
  const health = await request("", {path: "/healthz", method: "GET"});
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {ok: true, mode: "test"});
  assert.deepEqual(evidence, []);
});

test("requires JSON UTF-8 and rejects compressed bodies", async t => {
  const {request, evidence} = await fixture(t);
  for (const headers of [
    {"Content-Type": "text/plain"}, {"Content-Type": ""},
    {"Content-Type": "application/json; charset=utf-16"}, {"Content-Encoding": "gzip"},
  ]) assert.equal((await request(BODY, {headers})).status, 415);
  assert.equal((await request(BODY, {headers: {"Content-Type": "application/json; charset=UTF-8"}})).status, 200);
  assert.equal(evidence.length, 1);
});

test("invalid JSON and invalid UTF-8 never record an event", async t => {
  const {request, evidence} = await fixture(t);
  for (const body of ["{", "", "null", "[]", Buffer.from([0xc3, 0x28])]) {
    assert.equal((await request(body)).status, 400);
  }
  assert.deepEqual(evidence, []);
});

test("rejects oversized declared and chunked requests; accepts the exact byte limit", async t => {
  const {request, evidence} = await fixture(t);
  const large = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
  assert.equal((await request(large)).status, 413);
  assert.equal((await request(large, {chunked: true})).status, 413);
  const json = JSON.stringify(BODY);
  const exact = json + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(exact), MAX_BODY_BYTES);
  assert.equal((await request(exact)).status, 200);
  assert.equal(evidence.length, 1);
});

test("required fields and field types follow the actual GAD payload", async t => {
  const {request, evidence} = await fixture(t);
  const cases = [];
  for (const field of Object.keys(BODY)) {
    const missing = {...BODY}; delete missing[field]; cases.push(missing);
  }
  cases.push(
    {...BODY, extra: "not part of this sample contract"},
    {...BODY, seq: ""}, {...BODY, seq: 123}, {...BODY, uid: ""}, {...BODY, uid: "u".repeat(49)},
    {...BODY, adKey: null}, {...BODY, adTitle: 1}, {...BODY, publisher_data: {}},
    {...BODY, point: "5"}, {...BODY, point: 1.5}, {...BODY, point: -1},
    {...BODY, point: Number.MAX_SAFE_INTEGER + 1}, {...BODY, point: null},
    {...BODY, uid: "bad\nuser"},
  );
  for (const body of cases) assert.equal((await request(body)).status, 400);
  assert.deepEqual(evidence, []);
});

test("zero reward and null publisher data are valid; uid can be 48 characters", async t => {
  const {request, evidence} = await fixture(t);
  const response = await request({...BODY, point: 0, publisher_data: null, uid: "u".repeat(48)});
  assert.equal(response.status, 200);
  assert.equal(evidence[0].point, 0);
});

test("evidence is recorded before success; a write failure remains retryable", async t => {
  const evidence = [];
  let fail = true;
  const {request} = await fixture(t, {}, event => {
    if (fail) { fail = false; throw new Error("private path must not be returned"); }
    evidence.push(event);
  });
  const first = await request();
  assert.equal(first.status, 503);
  assert.deepEqual(first.body, {error: "receiver_unavailable"});
  const second = await request();
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, false);
  assert.equal(evidence.length, 1);
});

test("optional test failure returns 503 with Retry-After 30, then accepts once", async t => {
  const {request, evidence} = await fixture(t, {failFirst: 1});
  const first = await request();
  assert.equal(first.status, 503);
  assert.equal(first.headers["retry-after"], "30");
  assert.equal((await request({...BODY, point: 6})).status, 409);
  const second = await request();
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, false);
  assert.equal((await request()).body.duplicate, true);
  assert.deepEqual(evidence.map(event => event.outcome), ["simulated_failure", "conflict", "accepted", "duplicate"]);
});

test("test failure mode is off by default and HTTP timeout bounds are set", async t => {
  const {request, server} = await fixture(t);
  assert.equal((await request()).status, 200);
  assert.equal(server.headersTimeout, 5000);
  assert.equal(server.requestTimeout, 10000);
  assert.equal(server.keepAliveTimeout, 1000);
});

test("private JSON configuration is read without opening a server", t => {
  const directory = mkdtempSync(join(tmpdir(), "gad-postback-config-test-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, "config.json");
  const value = config({evidenceFile: join(directory, "evidence.jsonl"), allowedUids: [BODY.uid], runMarker: BODY.publisher_data});
  writeFileSync(path, JSON.stringify(value), {mode: 0o600});
  assert.equal(readConfig(path).host, "127.0.0.1");
  assert.equal(readConfig(path).failFirst, 0);
  assert.equal(readConfig(path).mediaKeys[0], MEDIA_KEY);
  assert.throws(() => readConfig("relative.json"));
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    assert.throws(() => readConfig(path), /private regular file/);
    chmodSync(path, 0o600);
    const link = join(directory, "link.json");
    symlinkSync(path, link);
    assert.throws(() => readConfig(link), /private regular file/);
  }
  writeFileSync(path, " ".repeat(16385));
  assert.throws(() => readConfig(path), /too large/);
});

test("invalid or publicly bound configuration fails closed", () => {
  for (const override of [
    {mediaKeys: []}, {mediaKeys: [""]}, {mediaKeys: [MEDIA_KEY, MEDIA_KEY]},
    {pathToken: "short"}, {pathToken: "x".repeat(32) + "/extra"}, {host: "0.0.0.0"},
    {port: 0}, {port: 65536}, {port: "3800"}, {evidenceFile: "relative.jsonl"},
    {failFirst: -1}, {failFirst: 4}, {allowedUids: []}, {allowedUids: ["u".repeat(49)]}, {runMarker: ""},
  ]) assert.throws(() => createPostbackReceiver(config(override), {writeEvidence() {}}));
});

test("real evidence file is private and contains only the redacted record", async t => {
  const directory = mkdtempSync(join(tmpdir(), "gad-postback-evidence-test-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, "evidence.jsonl");
  const server = createPostbackReceiver(config({evidenceFile: path}));
  await new Promise(fulfill => server.listen(0, "127.0.0.1", fulfill));
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/postback/" + PATH_TOKEN,
    {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(BODY)});
  assert.equal(response.status, 200);
  await response.text();
  const closed = new Promise(fulfill => server.close(fulfill)); server.closeAllConnections(); await closed;
  const text = readFileSync(path, "utf8");
  const record = JSON.parse(text.trim());
  assert.deepEqual(Object.keys(record), ["at", "seqHash", "mediaIndex", "outcome", "status", "point", "attempt"]);
  for (const secret of [BODY.seq, MEDIA_KEY, PATH_TOKEN, BODY.uid, BODY.publisher_data]) assert.equal(text.includes(secret), false);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o077, 0);
});

test("CLI configuration errors never print the private configuration", t => {
  const directory = mkdtempSync(join(tmpdir(), "gad-postback-cli-test-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, "config.json");
  writeFileSync(path, '{"private-secret-must-not-leak":', {mode: 0o600});
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    {env: {...process.env, GAD_POSTBACK_CONFIG: path}, encoding: "utf8"});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("private-secret-must-not-leak"), false);
  assert.equal(result.stderr.includes(path), false);
});
