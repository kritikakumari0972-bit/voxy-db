import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import worker from "../src/index.js";

globalThis.crypto ||= webcrypto;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class D1StatementMock {
  constructor(database, sql) { this.database = database; this.sql = sql; this.parameters = []; }
  bind(...parameters) { this.parameters = parameters; return this; }
  first() { return this.database.prepare(this.sql).get(...this.parameters) ?? null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.parameters) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.parameters);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
}

class D1DatabaseMock {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const migrations = readdirSync(join(root, "migrations")).filter((file) => file.endsWith(".sql")).sort();
    for (const migration of migrations) this.sqlite.exec(readFileSync(join(root, "migrations", migration), "utf8"));
  }
  prepare(sql) { return new D1StatementMock(this.sqlite, sql); }
  batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.sqlite.close(); }
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
async function hash(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function fixture() {
  const DB = new D1DatabaseMock();
  const userId = "usr_integration";
  const projectId = "prj_integration";
  const collectionId = "col_integration";
  const apiKey = "ndb_live_integration_test_key_1234567890";
  DB.prepare("INSERT INTO users (id, google_sub, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(userId, "google-sub", "test@example.com", "Integration Test", new Date().toISOString(), new Date().toISOString()).run();
  DB.prepare("INSERT INTO projects (id, owner_id, name, created_at, storage_backend) VALUES (?, ?, ?, ?, 'd1')")
    .bind(projectId, userId, "Integration Project", new Date().toISOString()).run();
  DB.prepare("INSERT INTO collections (id, project_id, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(collectionId, projectId, "posts", new Date().toISOString()).run();
  DB.prepare("INSERT INTO api_keys (id, project_id, label, key_prefix, key_hash, scopes, allowed_origins, created_at) VALUES (?, ?, ?, ?, ?, 'read_write', '[]', ?)")
    .bind("key_integration", projectId, "Integration Key", apiKey.slice(0, 18), await hash(apiKey), new Date().toISOString()).run();
  const env = {
    DB,
    ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
  };
  return { DB, env, apiKey, projectId };
}

function apiRequest(projectId, apiKey, path, options = {}) {
  return new Request(`https://db.example/v1/projects/${projectId}/collections/posts/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
}

test("public API persists records, records durable events, and replays idempotent creates", async () => {
  const { DB, env, apiKey, projectId } = await fixture();
  try {
    const body = JSON.stringify({ data: { title: "First post", visible: true } });
    const createRequest = () => apiRequest(projectId, apiKey, "records", {
      method: "POST", headers: { "Idempotency-Key": "create-first-post" }, body,
    });
    const first = await worker.fetch(createRequest(), env);
    assert.equal(first.status, 201);
    const firstPayload = await first.json();
    assert.equal(firstPayload.record.data.title, "First post");

    const replay = await worker.fetch(createRequest(), env);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    const replayPayload = await replay.json();
    assert.equal(replayPayload.record.id, firstPayload.record.id);

    const count = await DB.prepare("SELECT COUNT(*) AS count FROM records").first();
    const eventCount = await DB.prepare("SELECT COUNT(*) AS count FROM change_events").first();
    assert.equal(Number(count.count), 1);
    assert.equal(Number(eventCount.count), 1);

    const changes = await worker.fetch(apiRequest(projectId, apiKey, "changes?after=0"), env);
    assert.equal(changes.status, 200);
    const changePayload = await changes.json();
    assert.equal(changePayload.changes.length, 1);
    assert.equal(changePayload.changes[0].type, "record.created");
    assert.equal(changePayload.changes[0].record.id, firstPayload.record.id);
    assert.equal(changePayload.cursor, changePayload.changes[0].seq);
  } finally { DB.close(); }
});

test("public API rejects idempotency-key reuse with a different payload", async () => {
  const { DB, env, apiKey, projectId } = await fixture();
  try {
    const make = (title) => apiRequest(projectId, apiKey, "records", {
      method: "POST", headers: { "Idempotency-Key": "same-operation" },
      body: JSON.stringify({ data: { title } }),
    });
    assert.equal((await worker.fetch(make("A"), env)).status, 201);
    const conflict = await worker.fetch(make("B"), env);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_KEY_REUSED");
    const count = await DB.prepare("SELECT COUNT(*) AS count FROM records").first();
    assert.equal(Number(count.count), 1);
  } finally { DB.close(); }
});

test("list pagination uses cursor and returns a snapshot change cursor", async () => {
  const { DB, env, apiKey, projectId } = await fixture();
  try {
    for (let i = 0; i < 3; i += 1) {
      const response = await worker.fetch(apiRequest(projectId, apiKey, "records", {
        method: "POST", body: JSON.stringify({ data: { index: i } }),
      }), env);
      assert.equal(response.status, 201);
    }
    const first = await worker.fetch(apiRequest(projectId, apiKey, "records?limit=2"), env);
    const firstPage = await first.json();
    assert.equal(firstPage.records.length, 2);
    assert.ok(firstPage.nextCursor);
    assert.equal(firstPage.cursor, 3);
    const second = await worker.fetch(apiRequest(projectId, apiKey, `records?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`), env);
    const secondPage = await second.json();
    assert.equal(secondPage.records.length, 1);
    assert.equal(secondPage.nextCursor, null);
    const ids = [...firstPage.records, ...secondPage.records].map((record) => record.id);
    assert.equal(new Set(ids).size, 3);
  } finally { DB.close(); }
});

test("scheduled retention checkpoints expired events and rejects stale cursors", async () => {
  const { DB, env, apiKey, projectId } = await fixture();
  try {
    const created = await worker.fetch(apiRequest(projectId, apiKey, "records", {
      method: "POST", body: JSON.stringify({ data: { title: "Old record" } }),
    }), env);
    assert.equal(created.status, 201);
    await DB.prepare("UPDATE change_events SET created_at = ?")
      .bind(new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString()).run();

    await worker.scheduled({}, env, { waitUntil() {} });

    const remaining = await DB.prepare("SELECT COUNT(*) AS count FROM change_events").first();
    assert.equal(Number(remaining.count), 0);
    const changes = await worker.fetch(apiRequest(projectId, apiKey, "changes?after=0"), env);
    assert.equal(changes.status, 410);
    const payload = await changes.json();
    assert.equal(payload.error.code, "CURSOR_EXPIRED");
    assert.equal(payload.snapshotRequired, true);

    const snapshotResponse = await worker.fetch(apiRequest(projectId, apiKey, "records?limit=50"), env);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.cursor, payload.cursor);
    assert.ok(snapshot.cursor > 0, "fresh snapshot must advance beyond pruned history");
    const replayFromSnapshot = await worker.fetch(apiRequest(projectId, apiKey, `changes?after=${snapshot.cursor}`), env);
    assert.equal(replayFromSnapshot.status, 200);
  } finally { DB.close(); }
});
