# VoxyDB v0.5.1

VoxyDB is a real, hosted JSON document database backend for websites, Android/iOS apps, desktop apps and server-side services. It includes a management dashboard, Google Sign-In, project-scoped API keys, persistent records, a REST API, a JavaScript SDK, realtime subscriptions, durable change replay, cursor pagination and retry-safe writes.

**Database runtime:** Cloudflare Workers + D1 + SQLite-backed Durable Objects. **Optional backup mirror:** Google Drive. **Render support:** a Render Web Service gateway can provide a Render URL while forwarding to the durable Cloudflare backend.

## What it is — and what it is not

- D1 is the primary transactional database. Every accepted record mutation is persisted there before a success response is returned.
- VoxyDB is a JSON document database API, not a public SQL server. It provides record CRUD and collection APIs; it does not expose arbitrary SQL to client apps.
- Google Drive is an optional asynchronous JSON-file mirror. It is not the primary database, and editing mirror files directly does not currently write changes back into D1.
- Realtime WebSockets provide low-latency notifications. A durable D1 change log is the source of truth for replay after reconnects. Events are retained for seven days.
- VoxyDB is free/open-source software, but hosting provider quotas and account policies apply. Free does not mean unlimited.

## v0.5.1 improvements

- **Render Web Service gateway:** optional Node.js gateway forwards dashboard/API requests, Google OAuth callbacks/cookies, and WebSocket upgrades to the Cloudflare Worker. Database state remains on D1/Durable Objects; the gateway has no local data store.
- **Render-safe OAuth origin:** `PUBLIC_BASE_URL` configures Google Sign-In/Drive callback URLs and dashboard CSRF origin checks when using the Render gateway.
- **Render Blueprint:** `render.yaml`, `npm start`, health endpoint, graceful WebSocket shutdown, and proxy integration tests.

### v0.5.0 database improvements

- **Durable event log:** each public API and dashboard record mutation stores a change event in the same D1 batch as the record write and optional Drive outbox entry.
- **Reconnect recovery:** `GET .../changes?after=CURSOR` replays events. The SDK catches up on socket open/reconnect and emits events in order.
- **Snapshot cursors:** record list responses include a `cursor` and cursor-based `nextCursor` pagination.
- **Idempotent writes:** `Idempotency-Key` prevents duplicate create/update/delete operations when apps retry after network failures. Cached responses expire after 24 hours.
- **Seven-day retention:** the scheduled Worker job prunes old change records and records per-collection retention checkpoints so clients can detect expired cursors.
- **App SDK:** `public/voxydb.js` supports list/get/create/replace/update/delete/changes/subscribe, structured API errors, retry-safe mutation requests and automatic realtime reconnect.
- **Integration samples:** vanilla JavaScript, React, Node.js, Python, Kotlin/Android and Flutter/Dart.
- **Guided deployment:** `npm run setup` creates or reuses the D1 database, configures Google OAuth secrets, applies migrations and deploys the Worker.
- **Google Sign-In remains enabled** for the dashboard. Google Drive permission is a separate optional storage authorization (`drive.file`).

## Fast setup

Requirements: Node.js 20+, npm, a Cloudflare account, and a Google OAuth 2.0 Web client.

```bash
npm run setup
```

The guided flow:

1. Installs Wrangler if it is not installed locally.
2. Opens Cloudflare login if needed.
3. Creates or reuses `voxydb-production` D1 in the Asia-Pacific region.
4. Applies all remote D1 migrations.
5. Deploys the dashboard, REST API and realtime service to obtain the Worker URL.
6. Prompts for the Google OAuth Web Client ID and Client Secret and stores them as Worker secrets. Wrangler deploys a new Worker version when each secret is added.
7. Optionally generates and stores the Drive refresh-token encryption key.
8. Prints the exact Google OAuth callback URLs to register in the Google Cloud OAuth Web client.

Create a Google OAuth client of type **Web application** before starting setup. After setup prints the callback URI, add it under the client's **Authorized redirect URIs**, then open your Worker URL and sign in with Google. If the OAuth consent screen is in testing mode, add your Google account as a test user. To use Drive mirroring, enable the Google Drive API in the same Google Cloud project before connecting Drive from the Storage page. If setup is interrupted while entering credentials, rerun `npm run setup`; it reuses the D1 database and reapplies migrations safely.\n\nPrefer deploying from GitHub without a local terminal? Follow [`docs/CLOUDFLARE-DEPLOY.md`](docs/CLOUDFLARE-DEPLOY.md) to add account/OAuth values as GitHub Actions secrets and run the manual **Deploy VoxyDB to Cloudflare** workflow.

Later updates:

```bash
npm run deploy
```

This applies pending migrations to the D1 binding named `DB`, then deploys the Worker.

More complete setup and app integration instructions: [`docs/QUICKSTART.md`](docs/QUICKSTART.md). For the optional Render public URL, follow [`docs/RENDER.md`](docs/RENDER.md). For GitHub repository details and cloning instructions, see [`docs/GITHUB-PUSH.md`](docs/GITHUB-PUSH.md).

## Connect applications

### JavaScript / React

Import the hosted SDK from your deployed VoxyDB Worker:

```js
import { VoxyDB } from "https://YOUR-VOXYDB-WORKER.workers.dev/voxydb.js";

const db = new VoxyDB({
  baseUrl: "https://YOUR-VOXYDB-WORKER.workers.dev",
  projectId: "YOUR_PROJECT_ID",
  apiKey: "YOUR_READ_ONLY_KEY"
});

const snapshot = await db.list("posts", 100);
render(snapshot.records);

const stop = await db.subscribe("posts", onChange, {
  cursor: snapshot.cursor,
  onSnapshotRequired: async () => {
    const fresh = await db.list("posts", 100);
    render(fresh.records);
    return fresh.cursor;
  }
});
```

### Other languages

When using Render, replace the Worker URL with your Render gateway URL. Any platform that supports HTTPS JSON requests can use the REST API directly. See `examples/` for React, Node, Python, Kotlin/Android and Flutter/Dart samples. Keep write-capable API keys on trusted servers; use read-only keys in public browser/mobile code.

### REST endpoints

Base collection endpoint:

```text
/v1/projects/{projectId}/collections/{collection}/records
```

| Method | Route | Purpose |
|---|---|---|
| GET | `/records?limit=50&cursor=...` | List records with cursor pagination |
| POST | `/records` | Create a JSON record |
| GET | `/records/{id}` | Read one record |
| PUT | `/records/{id}` | Replace a record |
| PATCH | `/records/{id}` | Shallow-merge fields into a record |
| DELETE | `/records/{id}` | Delete a record |
| GET | `/changes?after={cursor}` | Replay changes after a durable cursor |
| POST | `/realtime-ticket` | Create a one-use WebSocket ticket |
| GET | `/realtime?ticket=...` | Connect to read-only realtime notifications |

Send `Authorization: Bearer ndb_live_...` and JSON mutation requests with `Content-Type: application/json`. Mutation requests support `Idempotency-Key`.

## Consistency and synchronization

A record write commits to D1 along with its change-log event and (when Drive mirroring is enabled) its Drive outbox job. The API returns only after the D1 batch succeeds. The Worker then broadcasts a WebSocket notification. The SDK treats the socket as a wake-up signal and fetches missing changes from the durable log. If a client cursor is older than retained history, VoxyDB returns `410 CURSOR_EXPIRED`; refresh a snapshot and subscribe from its new cursor.

Drive mirroring is asynchronous and eventually consistent. A write remains available from D1 while Drive is temporarily unavailable; the outbox retries. This is not a distributed transaction across D1 and Drive.

## Limits

- JSON object records up to 32 KB.
- JSON request bodies up to 64 KB.
- Up to 100 records per list page and 500 change events per page.
- Seven-day change-history retention.
- Up to 50 collections per project, 10 projects per Google account and 20 active API keys per project in this starter configuration.
- D1 is the operational database. Drive files are a backup mirror, not a native database mount.

Provider quotas, Google API quotas, deployment limits and free-tier policies can change. Check current provider documentation before launch:

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 pricing and limits](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Google Drive API change tracking](https://developers.google.com/workspace/drive/api/guides/manage-changes)
- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

## Security

Read [`SECURITY.md`](SECURITY.md). API keys are shown once and stored as one-way hashes. Google Drive refresh tokens are encrypted before storage. Do not commit OAuth secrets, Cloudflare tokens, Drive encryption keys or write-capable API keys.
