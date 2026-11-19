import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "wrangler.jsonc");
const databaseName = "voxydb-production";
const bindingName = "DB";
const command = process.platform === "win32" ? "npx.cmd" : "npx";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required GitHub Actions secret: ${name}`);
  return value;
}

function execute(args, { input, capture = false, safeFailure = false } = {}) {
  const result = spawnSync(command, ["wrangler", ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    input,
    stdio: capture || input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw new Error(`Could not run Wrangler: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = safeFailure ? "" : (result.stderr || result.stdout || "").trim();
    throw new Error(`Wrangler command failed: wrangler ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

function parseJsonOutput(output) {
  const normalized = output.replace(/\u001b\[[0-9;]*m/g, "").trim();
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] !== "[" && normalized[index] !== "{") continue;
    try { return JSON.parse(normalized.slice(index)); }
    catch { /* Wrangler may print a status line before the JSON payload. */ }
  }
  return null;
}

function extractDatabases(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.result)) return parsed.result;
  if (Array.isArray(parsed?.databases)) return parsed.databases;
  return [];
}

async function setDatabaseId(databaseId) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const binding = config.d1_databases?.find((item) => item.binding === bindingName);
  if (!binding) throw new Error(`wrangler.jsonc is missing the ${bindingName} D1 binding.`);
  const changed = binding.database_id !== databaseId;
  binding.database_id = databaseId;
  if (changed) await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return changed;
}

function putSecret(name, value) {
  if (!value) return;
  // Pass the secret over stdin; never include it in command-line arguments or logs.
  execute(["secret", "put", name], { input: `${value}\n`, capture: true, safeFailure: true });
  console.log(`Stored Cloudflare Worker secret: ${name}`);
}

function git(args, { quiet = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Git command failed: git ${args.join(" ")}${result.stderr ? `\n${result.stderr.trim()}` : ""}`);
  }
  return result.stdout || "";
}

async function persistD1Binding() {
  const status = git(["status", "--porcelain", "--", "wrangler.jsonc"], { quiet: true }).trim();
  if (!status) return;
  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  git(["add", "wrangler.jsonc"]);
  git(["commit", "-m", "chore: configure production D1 binding"]);
  git(["push", "origin", "HEAD:main"]);
}

async function main() {
  required("CLOUDFLARE_API_TOKEN");
  required("CLOUDFLARE_ACCOUNT_ID");
  const googleClientId = required("GOOGLE_CLIENT_ID");
  const googleClientSecret = required("GOOGLE_CLIENT_SECRET");
  if (!googleClientId.endsWith(".apps.googleusercontent.com")) {
    throw new Error("GOOGLE_CLIENT_ID must be a Google OAuth Web Client ID ending in .apps.googleusercontent.com.");
  }

  console.log("Authenticating with Cloudflare...");
  execute(["whoami"], { capture: true });

  console.log(`Checking D1 database ${databaseName}...`);
  const listed = execute(["d1", "list", "--json"], { capture: true });
  const databases = extractDatabases(parseJsonOutput(listed.stdout));
  let database = databases.find((item) => (item.name || item.database_name) === databaseName);

  let databaseId = database?.uuid || database?.database_id || database?.id;
  if (!databaseId) {
    console.log("Creating the Asia-Pacific D1 database...");
    execute(["d1", "create", databaseName, "--location", "apac", "--update-config", "--binding", bindingName]);
    const updatedConfig = JSON.parse(await readFile(configPath, "utf8"));
    databaseId = updatedConfig.d1_databases?.find((item) => item.binding === bindingName)?.database_id;
  }
  if (!databaseId) throw new Error("Could not resolve the D1 database ID after listing/creation.");
  await setDatabaseId(databaseId);
  await persistD1Binding();

  console.log("Applying remote D1 migrations...");
  execute(["d1", "migrations", "apply", bindingName, "--remote"]);

  console.log("Deploying the VoxyDB Worker...");
  const firstDeploy = execute(["deploy"], { capture: true });
  const deploymentOutput = `${firstDeploy.stdout}\n${firstDeploy.stderr}`;
  const workerUrl = deploymentOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] || null;

  console.log("Configuring Google Sign-In secrets...");
  putSecret("GOOGLE_CLIENT_ID", googleClientId);
  putSecret("GOOGLE_CLIENT_SECRET", googleClientSecret);
  if (process.env.DRIVE_TOKEN_ENCRYPTION_KEY?.trim()) {
    if (process.env.DRIVE_TOKEN_ENCRYPTION_KEY.trim().length < 32) {
      throw new Error("DRIVE_TOKEN_ENCRYPTION_KEY must contain at least 32 characters.");
    }
    putSecret("DRIVE_TOKEN_ENCRYPTION_KEY", process.env.DRIVE_TOKEN_ENCRYPTION_KEY.trim());
  }

  console.log("Publishing the final Worker version...");
  execute(["deploy"]);
  console.log("VoxyDB Cloudflare deployment completed.");
  if (workerUrl) console.log(`Worker URL: ${workerUrl}`);
  console.log("Google OAuth redirect URI: add https://YOUR-WORKER.workers.dev/api/auth/google/callback to the Google OAuth Web Client.");
  console.log("Optional Drive callback: https://YOUR-WORKER.workers.dev/api/drive/callback");
}

main().catch((error) => {
  console.error(`\nVoxyDB Cloudflare deployment stopped: ${error.message}`);
  process.exitCode = 1;
});
