import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ApiError, STAGING_FIXTURE_KEY, assertSeparateFiles, createClient, readPrivateJson, validateClientConfig, writePrivateResult} from "./api-client.mjs";

const OPERATIONS = new Set(["list", "status", "reward-list", "join", "complete"]);
const fields = {
  list: ["adid", "include", "exclude"], status: ["adKey", "adid", "uid"],
  "reward-list": ["uid"], join: ["adKey", "uid", "adid", "data", "ip"], complete: ["adKey", "uid", "adid", "ip"],
};

export function summarize(result) {
  const summary = {ok: true, environment: result.environment, operation: result.operation, httpStatus: result.httpStatus, resultCode: result.resultCode};
  if (result.operation === "list" || result.operation === "rewards") summary.itemCount = result.data.items.length;
  if (result.operation === "status") summary.state = ({0: "no_completion_record", 22: "completed", 24: "review_pending"})[result.resultCode];
  if (result.operation === "join") summary.hasLandingUrl = Boolean(result.data.join.url);
  if (result.operation === "complete") {
    summary.alreadyCompleted = result.resultCode === 22 || result.resultCode === 30;
    if (!summary.alreadyCompleted) summary.point = result.data.reward.reward_point;
  }
  return summary;
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const output = dependencies.output ?? (value => console.log(JSON.stringify(value)));
  const errorOutput = dependencies.errorOutput ?? (value => console.error(JSON.stringify(value)));
  try {
    const operation = argv[0] ?? "list";
    const mutationFlag = argv.length === 2 && argv[1] === "--allow-staging-mutations";
    if (!OPERATIONS.has(operation) || argv.length > 2 || (argv.length === 2 && !mutationFlag)) throw new ApiError("invalid_arguments");
    const path = env.GAD_API_CONFIG;
    const input = readPrivateJson(path);
    // A file cannot silently enable mutations: the CLI deliberately ignores allowMutations.
    const config = validateClientConfig({...input, allowMutations: false});
    const parameters = input.request ?? {};
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new ApiError("invalid_parameters");
    const mutation = operation === "join" || operation === "complete";
    if (mutation && (config.environment !== "staging" || !mutationFlag || parameters.adKey !== STAGING_FIXTURE_KEY)) {
      throw new ApiError("explicit_staging_fixture_required");
    }
    if (!mutation && mutationFlag) throw new ApiError("invalid_arguments");
    const resultPath = input.privateResultFile ?? join(dirname(path), "api-response.private.json");
    assertSeparateFiles(path, resultPath);
    // Preflight the private output before making a request, including a state-changing one.
    writePrivateResult(resultPath, {pending: true, operation});
    const client = createClient({...config, allowMutations: mutation}, {fetch: dependencies.fetch});
    const selected = Object.fromEntries(fields[operation].filter(name => parameters[name] !== undefined).map(name => [name, parameters[name]]));
    const result = await client[operation === "reward-list" ? "rewards" : operation](selected);
    writePrivateResult(resultPath, result);
    output(summarize(result));
    return 0;
  } catch (error) {
    const safe = error instanceof ApiError ? error : new ApiError("example_failed");
    errorOutput({ok: false, code: safe.code, ...(safe.httpStatus !== undefined ? {httpStatus: safe.httpStatus} : {}),
      ...(safe.resultCode !== undefined ? {resultCode: safe.resultCode} : {})});
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
