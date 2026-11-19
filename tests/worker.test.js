import test from "node:test";
import assert from "node:assert/strict";
import worker, { getPublicOrigin, requireSameOrigin } from "../src/index.js";
import { RealtimeHub } from "../src/realtime-hub.js";

function mockEnv() {
  return {
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() { return { ok: 1 }; },
          async all() { return { results: [] }; },
          async run() { return { meta: { changes: 1 } }; },
        };
      },
    },
    ASSETS: { async fetch() { return new Response("static asset", { status: 200 }); } },
  };
}

test("health endpoint confirms D1 binding is reachable", async () => {
  const response = await worker.fetch(new Request("https://voxydb.example/api/health"), mockEnv());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.database, "connected");
});

test("public API preflight returns CORS headers without a database write", async () => {
  const response = await worker.fetch(new Request("https://voxydb.example/v1/projects/demo/collections/posts/records", {
    method: "OPTIONS",
    headers: { Origin: "https://client.example" },
  }), mockEnv());
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://client.example");
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("unknown public API path returns JSON and CORS", async () => {
  const response = await worker.fetch(new Request("https://voxydb.example/v1/not-a-route", {
    headers: { Origin: "https://client.example" },
  }), mockEnv());
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://client.example");
  const body = await response.json();
  assert.equal(body.error.code, "NOT_FOUND");
});

test("static asset responses include browser security headers and WebSocket CSP", async () => {
  const response = await worker.fetch(new Request("https://voxydb.example/"), mockEnv());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.match(response.headers.get("Content-Security-Policy"), /wss:/);
});

test("Google Drive refresh tokens are encrypted and can be decrypted", async () => {
  const { encryptRefreshToken, decryptRefreshToken } = await import("../src/google-drive.js");
  const token = "refresh-token-for-testing-only";
  const secret = "a-long-random-test-secret-with-more-than-32-characters";
  const encrypted = await encryptRefreshToken(token, secret);
  assert.notEqual(encrypted, token);
  assert.equal(encrypted.includes(token), false);
  assert.equal(await decryptRefreshToken(encrypted, secret), token);
});

test("Google Drive refresh-token encryption rejects a different secret", async () => {
  const { encryptRefreshToken, decryptRefreshToken, DriveApiError } = await import("../src/google-drive.js");
  const encrypted = await encryptRefreshToken("sensitive-test-token", "a-long-test-secret-that-is-at-least-32-characters");
  await assert.rejects(
    () => decryptRefreshToken(encrypted, "another-long-test-secret-of-at-least-32-chars"),
    (error) => error instanceof DriveApiError && error.code === "DRIVE_TOKEN_DECRYPT_FAILED",
  );
});

test("Google Sign-In is restored and requests only identity scopes", async () => {
  const env = mockEnv();
  env.GOOGLE_CLIENT_ID = "example-client-id.apps.googleusercontent.com";
  env.GOOGLE_CLIENT_SECRET = "test-secret";
  env.PUBLIC_BASE_URL = "https://voxy-db.onrender.com";
  const response = await worker.fetch(new Request("https://voxydb.example/api/auth/google/start"), env);
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get("Location"));
  assert.equal(target.hostname, "accounts.google.com");
  assert.equal(target.searchParams.get("redirect_uri"), "https://voxy-db.onrender.com/api/auth/google/callback");
  assert.equal(target.searchParams.get("scope"), "openid email profile");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.match(response.headers.get("Set-Cookie"), /voxydb_oauth/);
  assert.match(response.headers.get("Set-Cookie"), /HttpOnly/);
});

test("Google Drive storage requests drive.file separately from Google Sign-In", async () => {
  const env = mockEnv();
  env.GOOGLE_CLIENT_ID = "example-client-id.apps.googleusercontent.com";
  env.GOOGLE_CLIENT_SECRET = "test-secret";
  env.DRIVE_TOKEN_ENCRYPTION_KEY = "a-random-test-encryption-secret-with-at-least-32-characters";
  const response = await worker.fetch(new Request("https://voxydb.example/api/drive/connect", {
    headers: { Cookie: "__Host-voxydb_session=existing-session" },
  }), env);
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get("Location"));
  assert.equal(target.hostname, "accounts.google.com");
  assert.equal(target.searchParams.get("access_type"), "offline");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
  assert.doesNotMatch(target.searchParams.get("scope"), /openid|email|profile/);
  assert.match(response.headers.get("Set-Cookie"), /HttpOnly/);
});

test("legacy password-only admin login is not an authentication route", async () => {
  const response = await worker.fetch(new Request("https://voxydb.example/api/auth/login", {
    method: "POST",
    headers: { Origin: "https://voxydb.example", "Content-Type": "application/json" },
    body: JSON.stringify({ password: "not-an-auth-method" }),
  }), mockEnv());
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
});

test("RealtimeHub broadcasts committed events to connected sockets", async () => {
  const receivedA = [];
  const receivedB = [];
  const sockets = [
    { readyState: 1, send(value) { receivedA.push(JSON.parse(value)); }, close() {} },
    { readyState: 1, send(value) { receivedB.push(JSON.parse(value)); }, close() {} },
  ];
  const hub = new RealtimeHub({ getWebSockets: () => sockets }, {});
  const payload = { type: "record.created", projectId: "prj_test", collection: "posts", record: { id: "rec_test" } };
  const response = await hub.fetch(new Request("https://hub.internal/publish", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).delivered, 2);
  assert.deepEqual(receivedA[0], payload);
  assert.deepEqual(receivedB[0], payload);
});

test("RealtimeHub requires a WebSocket upgrade for connections", async () => {
  const hub = new RealtimeHub({ getWebSockets: () => [] }, {});
  const response = await hub.fetch(new Request("https://hub.internal/connect"));
  assert.equal(response.status, 426);
});


test("Render public origin is used for OAuth and CSRF validation", () => {
  const env = { PUBLIC_BASE_URL: "https://voxy-db.onrender.com" };
  const workerUrl = new URL("https://voxydb.example/api/projects");
  assert.equal(getPublicOrigin(env, workerUrl), "https://voxy-db.onrender.com");
  assert.doesNotThrow(() => requireSameOrigin(new Request("https://voxydb.example/api/projects", {
    method: "POST", headers: { Origin: "https://voxy-db.onrender.com" },
  }), workerUrl, env));
  assert.throws(() => requireSameOrigin(new Request("https://voxydb.example/api/projects", {
    method: "POST", headers: { Origin: "https://attacker.example" },
  }), workerUrl, env), /Cross-origin dashboard request blocked/);
});

test("Render public origin rejects non-origin paths and insecure external URLs", () => {
  const workerUrl = new URL("https://voxydb.example/api/projects");
  assert.throws(() => getPublicOrigin({ PUBLIC_BASE_URL: "https://voxy-db.onrender.com/console" }, workerUrl), /must be an HTTPS origin/);
  assert.throws(() => getPublicOrigin({ PUBLIC_BASE_URL: "http://voxy-db.onrender.com" }, workerUrl), /must be an HTTPS origin/);
});
