import test from "node:test";
import assert from "node:assert/strict";
import { VoxyDB, VoxyDBError } from "../public/voxydb.js";
import { NovaDB, NovaDBError } from "../public/novadb.js";

test("legacy NovaDB SDK names remain compatible", () => {
  assert.equal(NovaDB, VoxyDB);
  assert.equal(NovaDBError, VoxyDBError);
});

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch("open", {});
    });
  }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }
  dispatch(type, event) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
  send() {}
  close(code = 1000, reason = "closed") {
    this.readyState = 3;
    this.dispatch("close", { code, reason });
  }
  message(payload) { this.dispatch("message", { data: JSON.stringify(payload) }); }
}

test("SDK lists with stable pagination cursors", async () => {
  let requestedUrl;
  const db = new VoxyDB({
    projectId: "prj_test", apiKey: "ndb_live_test", baseUrl: "https://db.example",
    fetch: async (url) => { requestedUrl = new URL(url); return response({ records: [], cursor: 11, nextCursor: "page_2" }); },
  });
  const result = await db.list("posts", 25, { cursor: "page_1" });
  assert.equal(result.cursor, 11);
  assert.equal(requestedUrl.searchParams.get("limit"), "25");
  assert.equal(requestedUrl.searchParams.get("cursor"), "page_1");
});

test("SDK creates writes with an idempotency key", async () => {
  let requestOptions;
  const db = new VoxyDB({
    projectId: "prj_test", apiKey: "ndb_live_test", baseUrl: "https://db.example",
    fetch: async (_url, options) => { requestOptions = options; return response({ record: { id: "rec_1" } }, 201); },
  });
  const result = await db.create("posts", { title: "Hello" }, { retries: 0 });
  assert.equal(result.record.id, "rec_1");
  assert.match(requestOptions.headers["Idempotency-Key"], /^[A-Za-z0-9-]{16,64}$/);
});

test("SDK catches up durable changes after opening a realtime socket", async () => {
  const previousWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  const delivered = [];
  const statuses = [];
  let changePolls = 0;
  const db = new VoxyDB({
    projectId: "prj_test", apiKey: "ndb_live_test", baseUrl: "https://db.example",
    fetch: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/realtime-ticket")) return response({ ticket: "single-use-ticket" }, 201);
      if (parsed.pathname.endsWith("/changes")) {
        changePolls += 1;
        const after = Number(parsed.searchParams.get("after"));
        if (after < 14) return response({ changes: [{ seq: 14, eventId: "evt_14", type: "record.created", record: { id: "rec_14" } }], cursor: 14, hasMore: false });
        return response({ changes: [{ seq: 16, eventId: "evt_16", type: "record.updated", record: { id: "rec_16" } }], cursor: 16, hasMore: false });
      }
      throw new Error(`Unexpected route ${parsed.pathname}`);
    },
  });
  try {
    await db.subscribe("posts", (event) => delivered.push(event), { cursor: 10, onStatus: (status) => statuses.push(status) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].seq, 14);
    assert.equal(statuses.includes("connected"), true);
    FakeWebSocket.instances[0].message({ type: "record.updated", seq: 16 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].seq, 16);
    assert.equal(changePolls >= 2, true);
  } finally {
    FakeWebSocket.instances[0]?.close();
    globalThis.WebSocket = previousWebSocket;
  }
});

test("SDK exposes structured API errors", async () => {
  const db = new VoxyDB({
    projectId: "prj_test", apiKey: "ndb_live_test", baseUrl: "https://db.example",
    fetch: async () => response({ error: { code: "RECORD_NOT_FOUND", message: "Missing record" } }, 404),
  });
  await assert.rejects(() => db.get("posts", "rec_missing"), (error) => {
    assert.equal(error instanceof VoxyDBError, true);
    assert.equal(error.status, 404);
    assert.equal(error.code, "RECORD_NOT_FOUND");
    return true;
  });
});
