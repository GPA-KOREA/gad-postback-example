import test from "node:test";
import assert from "node:assert/strict";
import {chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ApiError, API_BASE_URLS, STAGING_FIXTURE_KEY, buildRequest, createClient, readPrivateJson, validateClientConfig, writePrivateResult} from "./api-client.mjs";
import {main, summarize} from "./api-example.mjs";

const KEY = "private-media-never-print&query=value";
const UID = "private-user-never-print";
const ADID = "11111111-1111-4111-8111-111111111111";
const USER_IP = "198.51.100.42";
const DATA = "private-publisher-data-never-print";
const input = (patch = {}) => ({mediaKey: KEY, ...patch});
const user = (patch = {}) => ({adKey: STAGING_FIXTURE_KEY, uid: UID, adid: ADID, ...patch});
const response = (value, options) => new Response(JSON.stringify(value), options);
const ok = operation => operation === "list" || operation === "rewards" ? {code: 0, items: []} :
  operation === "join" ? {code: 0, join: {id: "private-join-id", url: "https://example.com/private-landing"}} :
  operation === "complete" ? {code: 0, reward: {id: "private-reward-id", uid: UID, reward_point: 5}} : {code: 0};

function privateConfig(patch = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gad-api-client-test-"));
  const path = join(directory, "config.json");
  const value = {...input(), request: user({data: DATA, ip: USER_IP}), privateResultFile: join(directory, "response.json"), ...patch};
  writeFileSync(path, JSON.stringify(value), {mode: 0o600});
  return {directory, path, value, close: () => rmSync(directory, {recursive: true, force: true})};
}

function noSecrets(value) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [KEY, UID, ADID, USER_IP, DATA, "private-join-id", "private-reward-id", "https://example.com/private-landing"]) {
    assert.ok(!raw.includes(secret), `Secret leaked in output`);
  }
}

test("client defaults to staging read-only and rejects alternate API origins", async () => {
  assert.equal(validateClientConfig(input()).environment, "staging");
  const calls = [];
  const client = createClient(input(), {fetch: async (...args) => { calls.push(args); return response(ok("list")); }});
  await client.list();
  assert.equal(calls[0][0].origin, API_BASE_URLS.staging);
  await assert.rejects(client.join(user()), /mutations_not_enabled/);
  await assert.rejects(client.complete(user()), /mutations_not_enabled/);
  assert.equal(calls.length, 1);
  for (const patch of [{environment: "local"}, {environment: "toString"}, {environment: {}}, {timeoutMs: 0}, {timeoutMs: 30001},
    {mediaKey: "bad\nkey"}, {allowMutations: "yes"}, {apiBaseUrl: "https://attacker.example"},
    {apiBaseUrl: API_BASE_URLS.staging + "/"}, {apiBaseUrl: "https://user:pass@gad-staging.gpakorea.com"}]) {
    assert.throws(() => createClient(input(patch)), /invalid_configuration/);
  }
});

test("device identifiers can be provider-specific strings and have an explicit 64-character example limit", () => {
  for (const adid of ["provider-specific-device-identifier", "x".repeat(64), ADID]) {
    const request = buildRequest(input(), "status", {adKey: STAGING_FIXTURE_KEY, adid});
    assert.equal(request.url.searchParams.get("adid"), adid);
  }
});

test("GET query values are encoded and include/exclude use repeated parameters", () => {
  const request = buildRequest(input(), "list", {adid: ADID, include: [0, 1], exclude: [3, 5]});
  assert.equal(request.url.searchParams.get("media"), KEY);
  assert.deepEqual(request.url.searchParams.getAll("include"), ["0", "1"]);
  assert.deepEqual(request.url.searchParams.getAll("exclude"), ["3", "5"]);
  assert.equal(request.url.searchParams.get("query"), null);
  assert.equal(request.body, undefined);
  assert.equal(request.method, "GET");
});

test("all five operations match actual GET query and POST JSON routes", async () => {
  const calls = [];
  const client = createClient(input({allowMutations: true}), {fetch: async (url, options) => {
    calls.push({url, ...options});
    const operation = url.pathname === "/campaign/reward/list" ? "rewards" : url.pathname.split("/").at(-1);
    return response(ok(operation));
  }});
  await client.list({adid: ADID});
  await client.status(user());
  await client.join(user({data: DATA, ip: USER_IP}));
  await client.complete(user({ip: USER_IP}));
  await client.rewards({uid: UID});
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname]), [
    ["GET", "/campaign/list"], ["GET", "/campaign/status"], ["POST", "/campaign/join"],
    ["POST", "/campaign/complete"], ["GET", "/campaign/reward/list"],
  ]);
  for (const call of calls) {
    assert.equal(call.redirect, "manual"); assert.equal(call.credentials, "omit"); assert.equal(call.cache, "no-store");
    assert.ok(call.signal instanceof AbortSignal);
    if (call.method === "POST") {
      assert.equal(call.url.search, "");
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(JSON.parse(call.body).media, KEY);
    } else assert.equal(call.url.searchParams.get("media"), KEY);
  }
  assert.deepEqual(JSON.parse(calls[2].body), {media: KEY, ...user({data: DATA, ip: USER_IP})});
  assert.deepEqual(JSON.parse(calls[3].body), {media: KEY, ...user({ip: USER_IP})});
  assert.deepEqual([...calls[4].url.searchParams.keys()], ["media", "uid"]);
});

test("the library supports explicit production integration, with no implicit retries", async () => {
  const calls = [];
  const client = createClient(input({environment: "production", allowMutations: true}), {fetch: async (url, options) => {
    calls.push({url, options}); return response({code: 22, message: KEY});
  }});
  await assert.rejects(client.join(user()), error => error instanceof ApiError && error.resultCode === 22);
  const completed = await client.complete(user());
  assert.equal(completed.resultCode, 22);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.origin === API_BASE_URLS.production));
});

test("status 0, 22 and 24 and completion 22/30 remain distinct business outcomes", async () => {
  for (const code of [0, 22, 24]) {
    const client = createClient(input(), {fetch: async () => response({code, message: KEY})});
    const result = await client.status({adKey: STAGING_FIXTURE_KEY, adid: ADID});
    assert.equal(result.resultCode, code);
    assert.equal(summarize(result).state, ({0: "no_completion_record", 22: "completed", 24: "review_pending"})[code]);
    noSecrets(summarize(result));
  }
  for (const code of [22, 30]) {
    const client = createClient(input({allowMutations: true}), {fetch: async () => response({code})});
    assert.equal(summarize(await client.complete(user())).alreadyCompleted, true);
  }
});

test("missing identity, zero IDs, unsafe values and unknown request fields fail before fetch", async () => {
  let calls = 0;
  const client = createClient(input({allowMutations: true}), {fetch: async () => { calls++; return response({code: 0}); }});
  for (const params of [user({uid: "x".repeat(49)}), user({adid: "00000000-0000-0000-0000-000000000000"}),
    user({adid: "x".repeat(65)}), user({adid: "invalid\nidentifier"}), user({ip: "not-an-ip"}), user({data: "bad\nvalue"}), user({adKey: ""}),
    {adKey: STAGING_FIXTURE_KEY, uid: UID}, user({offset: 1000000})]) {
    await assert.rejects(client.join(params), /invalid_parameters/);
  }
  await assert.rejects(client.status({adid: ADID}), /invalid_parameters/);
  await assert.rejects(client.status({adKey: STAGING_FIXTURE_KEY}), /invalid_parameters/);
  await assert.rejects(client.rewards({}), /invalid_parameters/);
  for (const include of [1, ["1"], [-1], [10], Array(11).fill(1)]) await assert.rejects(client.list({include}), /invalid_parameters/);
  assert.equal(calls, 0);
});

test("HTTP errors and redirects are rejected without following or exposing server text", async () => {
  for (const status of [204, 302, 400, 403, 500]) {
    let calls = 0;
    const client = createClient(input(), {fetch: async () => {
      calls++; return new Response(status === 204 ? null : KEY, {status, headers: {Location: `https://example.com/${UID}`}});
    }});
    await assert.rejects(client.list(), error => {
      assert.equal(error.code, "unexpected_http_status"); assert.equal(error.httpStatus, status); noSecrets(error); return true;
    });
    assert.equal(calls, 1);
  }
});

test("HTTP 200 is insufficient without a valid result code and endpoint response shape", async () => {
  for (const body of [{}, {code: "0", items: []}, {code: 0}, {code: 0, items: {}}, {code: 20, message: KEY}]) {
    const client = createClient(input(), {fetch: async () => response(body)});
    await assert.rejects(client.list(), error => { noSecrets(error); return true; });
  }
  for (const [operation, body] of [["join", {code: 0, join: {url: KEY}}],
    ["complete", {code: 0, reward: {id: "r", uid: UID, reward_point: -1}}],
    ["complete", {code: 0, reward: {id: "r", uid: "another-user", reward_point: 5}}]]) {
    const client = createClient(input({allowMutations: true}), {fetch: async () => response(body)});
    await assert.rejects(client[operation](user()), /invalid_api_response/);
  }
});

test("malformed, oversized and invalid UTF-8 responses fail within bounded memory", async () => {
  const fixtures = [
    () => new Response(KEY), () => response(null), () => response([]),
    () => new Response("x".repeat(256 * 1024 + 1)),
    () => new Response("{}", {headers: {"Content-Length": String(256 * 1024 + 1)}}),
    () => new Response(new Uint8Array([0xff, 0xfe])),
  ];
  for (const fixture of fixtures) {
    const client = createClient(input(), {fetch: async () => fixture()});
    await assert.rejects(client.list(), error => { noSecrets(error); return true; });
  }
});

test("timeouts abort requests and network exception text is redacted", async () => {
  let signal;
  const client = createClient(input({timeoutMs: 10}), {fetch: async (_url, options) => {
    signal = options.signal; return new Promise(() => {});
  }});
  await assert.rejects(client.list(), /request_timeout/);
  assert.equal(signal.aborted, true);
  const throwing = createClient(input(), {fetch: async () => { throw new Error(`${KEY} ${UID}`); }});
  await assert.rejects(throwing.list(), error => { assert.equal(error.code, "request_failed"); noSecrets(error); return true; });
});

test("a response body that never finishes is also subject to the deadline", async () => {
  const client = createClient(input({timeoutMs: 10}), {fetch: async () => new Response(new ReadableStream({start() {}}))});
  await assert.rejects(client.list(), /request_timeout/);
});

test("private files reject public permissions, symlinks and hard links", () => {
  const files = privateConfig();
  try {
    assert.equal(readPrivateJson(files.path).mediaKey, KEY);
    writePrivateResult(files.value.privateResultFile, {first: "long-value"});
    writePrivateResult(files.value.privateResultFile, {last: 1});
    assert.deepEqual(JSON.parse(readFileSync(files.value.privateResultFile, "utf8")), {last: 1});
    if (process.platform !== "win32") {
      assert.equal(statSync(files.value.privateResultFile).mode & 0o077, 0);
      chmodSync(files.path, 0o644); assert.throws(() => readPrivateJson(files.path), /invalid_private_configuration/); chmodSync(files.path, 0o600);
      chmodSync(files.value.privateResultFile, 0o644); assert.throws(() => writePrivateResult(files.value.privateResultFile, {}), /private_result_write_failed/);
    }
    symlinkSync(files.path, join(files.directory, "linked.json"));
    assert.throws(() => readPrivateJson(join(files.directory, "linked.json")), /invalid_private_configuration/);
    assert.throws(() => writePrivateResult(join(files.directory, "linked.json"), {}), /private_result_write_failed/);
    linkSync(files.path, join(files.directory, "hardlink.json"));
    assert.throws(() => readPrivateJson(files.path), /invalid_private_configuration/);
    assert.throws(() => writePrivateResult(join(files.directory, "hardlink.json"), {}), /private_result_write_failed/);
    assert.throws(() => readPrivateJson("relative.json"), /invalid_private_configuration/);
  } finally { files.close(); }
});

test("CLI defaults to read-only list and prints summaries while saving raw data privately", async () => {
  const files = privateConfig(), messages = [], calls = [];
  try {
    const raw = {code: 0, items: [{key: "ad", uid: UID, url: `https://example.com/${KEY}`}], media: KEY};
    const exit = await main([], {GAD_API_CONFIG: files.path}, {fetch: async (url, options) => {
      calls.push([url, options]); return response(raw);
    }, output: value => messages.push(value), errorOutput: value => messages.push(value)});
    assert.equal(exit, 0); assert.equal(calls.length, 1); assert.equal(calls[0][1].method, "GET");
    assert.equal(messages[0].itemCount, 1); noSecrets(messages);
    const result = JSON.parse(readFileSync(files.value.privateResultFile, "utf8"));
    assert.deepEqual(result.data, raw);
    if (process.platform !== "win32") assert.equal(statSync(files.value.privateResultFile).mode & 0o077, 0);
  } finally { files.close(); }
});

test("CLI production verification is read-only even with an enabling file and flag", async () => {
  const files = privateConfig({environment: "production", allowMutations: true}), messages = [];
  let calls = 0;
  const dependencies = {fetch: async () => { calls++; return response({code: 0}); }, output: value => messages.push(value), errorOutput: value => messages.push(value)};
  try {
    for (const operation of ["join", "complete"]) {
      for (const argv of [[operation], [operation, "--allow-staging-mutations"]]) {
        assert.equal(await main(argv, {GAD_API_CONFIG: files.path}, dependencies), 1);
        assert.equal(messages.at(-1).code, "explicit_staging_fixture_required");
      }
    }
    assert.equal(calls, 0); noSecrets(messages);
  } finally { files.close(); }
});

test("CLI staging mutation needs the explicit flag and exact fixed fixture", async () => {
  const files = privateConfig(), messages = [], calls = [];
  const dependencies = {fetch: async (url, options) => {
    calls.push({url, options}); return response(ok(url.pathname.split("/").at(-1)));
  }, output: value => messages.push(value), errorOutput: value => messages.push(value)};
  try {
    assert.equal(await main(["join"], {GAD_API_CONFIG: files.path}, dependencies), 1);
    assert.equal(calls.length, 0);
    assert.equal(await main(["join", "--allow-staging-mutations"], {GAD_API_CONFIG: files.path}, dependencies), 0);
    assert.equal(await main(["complete", "--allow-staging-mutations"], {GAD_API_CONFIG: files.path}, dependencies), 0);
    assert.equal(messages.at(-1).point, 5); noSecrets(messages);
    writeFileSync(files.path, JSON.stringify({...files.value, request: user({adKey: "real-campaign"})}));
    assert.equal(await main(["join", "--allow-staging-mutations"], {GAD_API_CONFIG: files.path}, dependencies), 1);
    assert.equal(calls.length, 2);
  } finally { files.close(); }
});

test("CLI status and reward-list use private config, with no identity in summaries", async () => {
  const files = privateConfig({environment: "production"}), messages = [], calls = [];
  try {
    for (const operation of ["status", "reward-list"]) {
      const exit = await main([operation], {GAD_API_CONFIG: files.path}, {fetch: async (url, options) => {
        calls.push({url, options}); return response(url.pathname.endsWith("status") ? {code: 24, message: KEY} : {code: 0, items: [{uid: UID}]});
      }, output: value => messages.push(value), errorOutput: value => messages.push(value)});
      assert.equal(exit, 0);
    }
    assert.ok(calls.every(call => call.options.method === "GET" && call.url.origin === API_BASE_URLS.production));
    assert.equal(messages[0].state, "review_pending"); assert.equal(messages[1].itemCount, 1); noSecrets(messages);
  } finally { files.close(); }
});

test("CLI bad arguments, unsafe output and configuration failures do not make requests", async () => {
  const files = privateConfig(), messages = [];
  let calls = 0;
  const dependencies = {fetch: async () => { calls++; throw new Error(KEY); }, output: value => messages.push(value), errorOutput: value => messages.push(value)};
  try {
    for (const argv of [[KEY], ["list", "--allow-staging-mutations"], ["status", "--unknown"], ["list", "a", "b"]]) {
      assert.equal(await main(argv, {GAD_API_CONFIG: files.path}, dependencies), 1);
    }
    for (const privateResultFile of [files.path, "relative.json"]) {
      writeFileSync(files.path, JSON.stringify({...files.value, privateResultFile}));
      assert.equal(await main([], {GAD_API_CONFIG: files.path}, dependencies), 1);
    }
    writeFileSync(files.path, JSON.stringify(files.value));
    writeFileSync(files.value.privateResultFile, "do-not-change", {mode: 0o644});
    if (process.platform !== "win32") assert.equal(await main([], {GAD_API_CONFIG: files.path}, dependencies), 1);
    assert.equal(calls, 0); noSecrets(messages);
    assert.equal(readFileSync(files.value.privateResultFile, "utf8"), "do-not-change");
  } finally { files.close(); }
});

test("CLI error output retains only numeric HTTP/result codes and fixed error names", async () => {
  const files = privateConfig(), messages = [];
  try {
    assert.equal(await main([], {GAD_API_CONFIG: files.path}, {fetch: async () => response({code: 20, message: `${KEY} ${UID}`}),
      output: value => messages.push(value), errorOutput: value => messages.push(value)}), 1);
    assert.deepEqual(messages[0], {ok: false, code: "api_result_error", httpStatus: 200, resultCode: 20});
    noSecrets(messages);
  } finally { files.close(); }
});
