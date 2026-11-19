# VoxyDB REST API v0.5.0

All public API routes use the deployed Worker origin and require an API key unless noted. Send `Authorization: Bearer ndb_live_...`. JSON mutation requests require `Content-Type: application/json`. Responses are JSON with structured errors.

## Records

Base: `/v1/projects/{projectId}/collections/{collection}/records`

| Method | Path | Scope | Response |
|---|---|---|---|
| GET | `/records?limit=50&cursor=...` | read/read_write | `{ records, cursor, nextCursor }` |
| POST | `/records` | write/read_write | `{ record, driveSync }` |
| GET | `/records/{id}` | read/read_write | `{ record }` |
| PUT | `/records/{id}` | write/read_write | `{ record, driveSync }` |
| PATCH | `/records/{id}` | write/read_write | `{ record, driveSync }` |
| DELETE | `/records/{id}` | write/read_write | `{ ok, id, driveSync }` |

Create body:

```json
{ "data": { "title": "Hello VoxyDB", "active": true } }
```

Records must be JSON objects. The maximum serialized record size is 32 KB. List pages accept a `limit` from 1 to 100. Pass `nextCursor` as the `cursor` query parameter to retrieve the next page. List responses also include a collection change `cursor` for realtime setup.

## Idempotency

Create/update/delete requests may include:

```http
Idempotency-Key: operation-unique-id-001
```

The key must contain 1–128 letters, digits, `.`, `_`, `:` or `-`. VoxyDB stores the response atomically with the mutation for 24 hours. Repeating the same key and same request returns the stored response and `Idempotency-Replayed: true`. Reusing a key for a different method, path or body returns `409 IDEMPOTENCY_KEY_REUSED`.

## Durable change history

```http
GET /v1/projects/{projectId}/collections/{collection}/changes?after=CURSOR&limit=100
Authorization: Bearer ndb_live_READ_KEY
```

Response:

```json
{
  "changes": [
    {
      "seq": 41,
      "eventId": "evt_example",
      "createdAt": "2026-11-18T09:00:00.000Z",
      "type": "record.created",
      "record": { "id": "rec_example", "data": { "title": "Hello" } }
    }
  ],
  "cursor": 41,
  "hasMore": false
}
```

Event types: `record.created`, `record.updated`, `record.deleted`. The event log is retained for seven days. If `after` is older than the collection's retention checkpoint, VoxyDB returns `410 CURSOR_EXPIRED`, `snapshotRequired: true` and the current cursor. Fetch a new records snapshot and resume from its `cursor`.

## WebSocket notifications

- `POST /v1/projects/{projectId}/collections/{collection}/realtime-ticket` exchanges the read-capable API key for a single-use 60-second ticket.
- `GET /v1/projects/{projectId}/collections/{collection}/realtime?ticket=...` upgrades to a read-only WebSocket.

A permanent API key is never placed in the WebSocket URL. WebSocket messages are wake-up notifications; the JavaScript SDK fetches the durable event log after open/reconnect to recover missed events.

## JavaScript SDK

```js
import { VoxyDB } from "https://YOUR-WORKER.workers.dev/voxydb.js";

const db = new VoxyDB({
  baseUrl: "https://YOUR-WORKER.workers.dev",
  projectId: "PROJECT_ID",
  apiKey: "READ_ONLY_KEY"
});

const snapshot = await db.list("posts", 100);
render(snapshot.records);
const stop = await db.subscribe("posts", (event) => applyChange(event), {
  cursor: snapshot.cursor,
  onSnapshotRequired: async () => {
    const fresh = await db.list("posts", 100);
    render(fresh.records);
    return fresh.cursor;
  }
});
```

SDK methods: `list`, `get`, `create`, `replace`, `update`, `delete`, `changes`, and `subscribe`. Create/update/delete automatically generate an idempotency key and retry transient network failures. Supply your own `idempotencyKey` to reuse one for a logical operation. `subscribe` returns a stop function.

## CORS and API origins

API keys can have up to 10 exact allowed website origins. Set these in the dashboard when creating a browser key. CORS is a browser policy, not a replacement for authentication or authorization; server-to-server requests may not send an Origin header. Never put a write-capable key in a public website bundle or mobile package.

## Google Sign-In and Drive storage

Google Sign-In (`openid email profile`) authenticates the VoxyDB dashboard. Google Drive authorization (`drive.file`) is an optional, separate storage permission. D1 remains the operational database; Drive mirror writes are asynchronous and retried through the D1 outbox.

## Errors

```json
{ "error": { "code": "RECORD_NOT_FOUND", "message": "Record not found" } }
```

Common statuses: 400 invalid JSON/cursor, 401 missing or invalid key, 403 insufficient scope/origin blocked, 404 unknown collection/record, 409 migration conflict or idempotency key reuse, 410 expired change cursor, 413 size limit exceeded, 422 invalid record/name/key and 500 unexpected server error.


## Render base URL

VoxyDB can be reached through the optional Render Web Service gateway. When configured, set the SDK `baseUrl` to the Render `onrender.com` URL instead of the direct Worker URL. The gateway forwards HTTPS API requests and WebSocket upgrades to the Cloudflare Worker; D1 remains the primary database. See [`RENDER.md`](RENDER.md).
