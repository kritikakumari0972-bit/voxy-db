import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "wrangler.jsonc");
const databaseName = "voxydb-production";
const bindingName = "DB";
const isWindows = process.platform === "win32";
const npx = isWindows ? "npx.cmd" : "npx";

function run(args, { input, inherit = true } = {}) {
  const result = spawnSync(npx, ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: inherit && input === undefined ? "inherit" : [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    shell: isWindows,
  });
  if (inherit && input === undefined) return { status: result.status ?? 1, stdout: "", stderr: "" };
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function parseJsonOutput(output) {
  const normalized = output.replace(/\u001b\[[0-9;]*m/g, "").trim();
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] !== "[" && normalized[index] !== "{") continue;
    try { return JSON.parse(normalized.slice(index)); }
    catch { /* keep looking in case Wrangler wrote a status prefix first */ }
  }
  return null;
}

async function readConfig() {
  return JSON.parse(await readFile(configPath, "utf8"));
}

async function writeDatabaseId(databaseId) {
  const config = await readConfig();
  const binding = config.d1_databases?.find((item) => item.binding === bindingName);
  if (!binding) throw new Error(`Could not find the ${bindingName} D1 binding in wrangler.jsonc`);
  binding.database_id = databaseId;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function findDatabase() {
  const listed = run(["d1", "list", "--json"], { inherit: false });
  if (listed.status !== 0) return null;
  const parsed = parseJsonOutput(listed.stdout);
  const items = Array.isArray(parsed) ? parsed : parsed?.result || parsed?.databases || [];
  return items.find((item) => (item.name || item.database_name) === databaseName) || null;
}

async function promptHidden(question) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const fallback = createInterface({ input: stdin, output: stdout });
    try { return (await fallback.question(`${question} (input may be visible in this terminal): `)).trim(); }
    finally { fallback.close(); }
  }
  stdout.write(`${question} (input hidden): `);
  return new Promise((resolve, reject) => {
    let value = "";
    const previousRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Setup cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    function cleanup() {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(previousRaw));
      stdin.pause();
    }
    stdin.on("data", onData);
  });
}

function putSecret(name, value) {
  const result = run(["secret", "put", name], { input: `${value}\n`, inherit: false });
  if (result.status !== 0) throw new Error(`Could not save ${name} to Cloudflare: ${(result.stderr || result.stdout).trim()}`);
}

async function main() {
  console.log("\nVoxyDB setup — create your live database backend\n");
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("VoxyDB requires Node.js 20 or newer.");

  try { await access(path.join(root, "node_modules", ".bin", isWindows ? "wrangler.cmd" : "wrangler")); }
  catch {
    console.log("Installing VoxyDB deployment tools...");
    const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit", shell: isWindows });
    if (install.status !== 0) throw new Error("npm install failed. Fix the npm error and run npm run setup again.");
  }

  const identity = run(["whoami"], { inherit: false });
  if (identity.status !== 0) {
    console.log("Opening Cloudflare login...");
    const login = run(["login"]);
    if (login.status !== 0) throw new Error("Cloudflare login did not complete.");
  }

  console.log("Checking Cloudflare D1 database...");
  let database = await findDatabase();
  if (database) {
    const id = database.uuid || database.database_id || database.id;
    if (!id) throw new Error("Found the D1 database, but Wrangler did not return its ID. Run `npx wrangler d1 list` and check your account.");
    await writeDatabaseId(id);
    console.log(`Using existing D1 database: ${databaseName}`);
  } else {
    console.log("Creating D1 database in the Asia-Pacific region...");
    const created = run(["d1", "create", databaseName, "--location", "apac", "--update-config", "--binding", bindingName]);
    if (created.status !== 0) throw new Error("Could not create D1. Check your Cloudflare account and rerun setup.");
    const config = await readConfig();
    const id = config.d1_databases?.find((item) => item.binding === bindingName)?.database_id;
    if (!id || id === "REPLACE_WITH_CLOUDFLARE_D1_DATABASE_ID") throw new Error("Wrangler did not update the D1 database ID in wrangler.jsonc.");
    console.log(`Created D1 database: ${databaseName}`);
  }


  console.log("\nApplying database migrations...");
  const migration = run(["d1", "migrations", "apply", bindingName, "--remote"]);
  if (migration.status !== 0) throw new Error("D1 migrations failed. Fix the reported issue and rerun `npm run setup`.");

  console.log("\nDeploying VoxyDB...");
  const deploy = run(["deploy"], { inherit: false });
  if (deploy.status !== 0) {
    console.error(deploy.stdout || "");
    console.error(deploy.stderr || "");
    throw new Error("Deployment failed. Rerun `npm run setup` after fixing the Wrangler error.");
  }
  console.log(deploy.stdout || "");
  if (deploy.stderr) console.log(deploy.stderr);

  const deployOutput = `${deploy.stdout || ""}\n${deploy.stderr || ""}`;
  const origin = deployOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] || null;
  console.log("\nVoxyDB Worker is deployed. Now configuring Google credentials...");

  console.log("\nGoogle Sign-In is required for the VoxyDB dashboard.");
  console.log("Create an OAuth 2.0 Web client in Google Cloud. The callback URLs are shown after deployment.");
  const rl = createInterface({ input: stdin, output: stdout });
  let clientId;
  try { clientId = await rl.question("Google OAuth Client ID: "); }
  finally { rl.close(); }
  if (!clientId.trim().endsWith(".apps.googleusercontent.com")) throw new Error("Enter the OAuth Web Client ID ending in .apps.googleusercontent.com.");
  const clientSecret = await promptHidden("Google OAuth Client Secret");
  if (!clientSecret) throw new Error("A Google OAuth Client Secret is required for Google Sign-In.");
  console.log("Saving Google OAuth credentials as encrypted Cloudflare Worker secrets...");
  putSecret("GOOGLE_CLIENT_ID", clientId.trim());
  putSecret("GOOGLE_CLIENT_SECRET", clientSecret);

  const driveRl = createInterface({ input: stdin, output: stdout });
  let enableDrive;
  try { enableDrive = (await driveRl.question("Enable optional Google Drive database mirroring? [y/N]: ")).trim().toLowerCase(); }
  finally { driveRl.close(); }
  if (["y", "yes"].includes(enableDrive)) {
    const driveKey = randomBytes(48).toString("base64url");
    putSecret("DRIVE_TOKEN_ENCRYPTION_KEY", driveKey);
    console.log("Drive token encryption key generated and stored as a Worker secret.");
    console.log("Enable the Google Drive API in the same Google Cloud project before connecting Drive in VoxyDB.");
  }

  console.log("\nGoogle credentials are configured. Wrangler deploys a new Worker version when a secret is added.");
  if (origin) {
    console.log(`Dashboard: ${origin}`);
    console.log("Add these exact redirect URIs to your Google OAuth Web client:");
    console.log(`${origin}/api/auth/google/callback`);
    console.log(`${origin}/api/drive/callback  (only if you enabled Drive mirroring)`);
  } else {
    console.log("Copy your workers.dev URL from the deployment output and register:");
    console.log("https://YOUR-WORKER.workers.dev/api/auth/google/callback");
    console.log("https://YOUR-WORKER.workers.dev/api/drive/callback (if using Drive)");
  }
  console.log("\nAfter adding the redirect URI, open your VoxyDB dashboard and sign in with Google.");
  console.log("Create a project, collection and read-only API key; then copy the SDK snippet from API Docs.");
  console.log("\nNote: Cloudflare and Google free-tier quotas apply. This setup does not create unlimited hosting or storage.\n");
}

main().catch((error) => {
  console.error(`\nSetup stopped: ${error.message}`);
  process.exitCode = 1;
});
