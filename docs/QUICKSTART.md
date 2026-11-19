# VoxyDB Quick Start — connect your first app

VoxyDB is a hosted JSON document database API. The dashboard runs on Cloudflare Workers, records are stored transactionally in Cloudflare D1, and optional Google Drive mirroring keeps a second copy of each record. Google Sign-In protects the management dashboard. App API keys are separate from Google authentication.

## 1. Deploy your own VoxyDB instance

Requirements: Node.js 20+, npm, a free Cloudflare account, and a Google OAuth 2.0 Web client.

From this folder run:

```bash
npm run setup
```

Before running it, create a Google OAuth 2.0 client of type **Web application** in Google Cloud and keep its Client ID and Client Secret ready. The guided setup installs Wrangler, opens Cloudflare login when needed, creates or reuses a D1 database in the Asia-Pacific region, applies all migrations, deploys the Worker, and then stores your Google OAuth credentials as Worker secrets. It prints the exact callback URLs after deployment. Add `https://YOUR-WORKER.workers.dev/api/auth/google/callback` as an **Authorized redirect URI** on your OAuth Web client before signing in for the first time. If the Google consent screen is in testing mode, add your Google account as a test user.

For Drive mirroring, choose yes when setup asks. Enable the Google Drive API in the same Google Cloud project. Drive is optional; D1 remains the live transactional database.

To deploy later after a code update:

```bash
npm run deploy
```

This applies pending remote D1 migrations before deploying the Worker.

## 2. Create a database and API key

1. Open the deployed dashboard and choose **Continue with Google**.
2. Create a project, for example `My App`.
3. Open **Collections** and create `posts`.
4. Open **API Keys** and create a **Read only** key for public browser/mobile apps.
5. Create a separate **Write only** or **Read + write** key for a trusted server. Never ship a write-capable key inside browser JavaScript or a mobile app package.
6. Open **API Docs** to copy your endpoint and SDK example.

A project is a namespace; a collection is similar to a SQL table; a record is a JSON object/document.

## 3. Website JavaScript SDK

Import the hosted ESM SDK directly from your deployed VoxyDB Worker:

```js
import { VoxyDB } from "https://YOUR-VOXYDB-WORKER.workers.dev/voxydb.js";

const db = new VoxyDB({
  baseUrl: "https://YOUR-VOXYDB-WORKER.workers.dev",
  projectId: "YOUR_PROJECT_ID",
  apiKey: "YOUR_READ_ONLY_API_KEY"
});

// Load a consistent snapshot and keep its change cursor.
const snapshot = await db.list("posts", 100);
renderPosts(snapshot.records);

// Subscribe after the snapshot cursor. Changes missed while disconnected
// are fetched from the durable change log after the socket reconnects.
const stop = await db.subscribe("posts", (change) => {
  console.log(change.type, change.record || change.id);
}, {
  cursor: snapshot.cursor,
  onStatus: (status, error) => console.log("VoxyDB", status, error || ""),
  onSnapshotRequired: async () => {
    const fresh = await db.list("posts", 100);
    renderPosts(fresh.records);
    return fresh.cursor;
  }
});

// On route/component unmount:
// stop();
```

The SDK automatically generates an `Idempotency-Key` for create/update/delete calls and safely retries network failures. You may pass your own stable `idempotencyKey` when you need to retry the same logical operation from different code paths.

## 4. Direct REST API — any language or platform

Base URL:

```text
https://YOUR-VOXYDB-WORKER.workers.dev/v1/projects/YOUR_PROJECT_ID/collections/posts/records
```

Create:

```bash
curl -X POST "$VOXYDB_URL" \
  -H "Authorization: Bearer $VOXYDB_WRITE_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-post-0001" \
  -d '{"data":{"title":"Hello VoxyDB","published":true}}'
```

List first page:

```bash
curl "$VOXYDB_URL?limit=50" \
  -H "Authorization: Bearer $VOXYDB_READ_KEY"
```

Read, replace, merge-update and delete:

```text
GET    /records/{recordId}
PUT    /records/{recordId}
PATCH  /records/{recordId}
DELETE /records/{recordId}
```

For the next page, pass `nextCursor` returned by the previous list response:

```text
GET /records?limit=50&cursor=NEXT_CURSOR
```

Durable change history:

```text
GET /v1/projects/{projectId}/collections/{collection}/changes?after=CURSOR&limit=100
```

Use an API key with `read` or `read_write` scope to read records and changes. Use a key with `write` or `read_write` scope for mutations.

## 5. Realtime and recovery behavior

VoxyDB commits a mutation, its event-log entry, its optional Drive mirror job, and its idempotency response in the same D1 batch. A successful response therefore has a durable event cursor to recover from. WebSockets are low-latency wake-up notifications; the D1 change log is the replay source of truth.

The event log keeps seven days of history. Apps should:

1. Fetch a record snapshot and keep its `cursor`.
2. Subscribe using that cursor.
3. On reconnect, replay changes after the last delivered sequence.
4. When the server returns `CURSOR_EXPIRED`, reload a snapshot and start again from its cursor.

## 6. Google Drive storage model

D1 is the primary transactional database. When Drive mirroring is enabled, successful writes enqueue a Drive JSON mirror in the same D1 transaction. Background jobs retry temporary failures. Reads and live queries always use D1, so a Drive API outage does not make the live database unavailable. Drive file edits are not imported back into D1 in this release.

## 7. Security checklist

- Use read-only keys in browser code and mobile apps.
- Keep write keys in server-side environment secrets.
- Restrict allowed website origins for browser keys (CORS is not a substitute for server-side authorization).
- Revoke leaked keys immediately from the dashboard.
- Do not commit Google OAuth secrets, Cloudflare tokens, or Drive encryption keys.
- Use HTTPS in production.

## 8. Limits in the starter release

- JSON object records up to 32 KB.
- Maximum 64 KB JSON request body.
- Up to 100 records per list page.
- Up to 500 events per change-log page.
- Seven-day event retention.
- Up to 50 collections per project, 10 projects per Google account, and 20 active API keys per project.
- D1 is a real SQL database behind VoxyDB's JSON document API; this is not a general-purpose SQL endpoint and does not yet provide cross-record transactions to client apps.

Cloudflare and Google usage quotas apply. Free tier availability, limits and policies can change; confirm them in the provider dashboards.


## Optional Render deployment

To use a Render `onrender.com` public URL, deploy the Cloudflare Worker backend first and then use the repository Blueprint in `render.yaml`. Render runs a Node.js gateway that forwards API, dashboard, OAuth and WebSocket traffic to Cloudflare; persistent database state remains in D1. Follow [`RENDER.md`](RENDER.md) for the full setup and Google OAuth callback configuration. Do not use Render Free filesystem or Free Postgres as VoxyDB primary storage.
