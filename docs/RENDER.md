# Render Web Service deployment

VoxyDB's database runtime is Cloudflare Workers + D1 + SQLite-backed Durable Objects. The `render.yaml` Blueprint deploys a small Node.js Web Service gateway on Render. The gateway forwards HTTP requests, Google OAuth redirects/callbacks, cookies, and WebSocket upgrades to your deployed VoxyDB Worker.

This gives the dashboard and API a Render `onrender.com` URL, while **the database and realtime state remain durable on Cloudflare**. This is intentional: Render Free Web Services have an ephemeral filesystem, and free Render Postgres databases expire after 30 days. Do not store VoxyDB's production database in the Render filesystem or a free Render Postgres instance.

## 1. Deploy the Cloudflare backend first

From the repository root, run:

```bash
npm install
npm run setup
```

Complete the Cloudflare login, D1 creation/migrations, and Google OAuth setup. Keep the resulting Worker URL, for example `https://voxydb.<your-subdomain>.workers.dev`.

## 2. Create the Render Web Service

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. Render reads `render.yaml` and creates the `voxy-db` Web Service.
4. When prompted for `CLOUDFLARE_WORKER_URL`, enter the complete HTTPS Worker origin, for example `https://voxydb.<your-subdomain>.workers.dev`.
5. Deploy. Render will provide a public URL such as `https://voxy-db.onrender.com`.

The Blueprint uses:

- Build command: `npm run render:check` (the gateway uses Node.js built-ins and has no runtime package dependencies)
- Start command: `npm start`
- Health check: `/_render/health`
- WebSocket upgrade tunnelling for realtime subscriptions

## 3. Set the public origin on the Cloudflare Worker

In the Cloudflare dashboard, open the VoxyDB Worker → **Settings → Variables and Secrets**. Add/update the plain-text variable:

```text
PUBLIC_BASE_URL=https://voxy-db.onrender.com
```

Use your actual Render URL and do not add a trailing slash. Redeploy the Worker after changing this variable.

`PUBLIC_BASE_URL` ensures that Google Sign-In and Google Drive OAuth generate callback URLs using the public Render domain, and that the dashboard's same-origin/CSRF check recognizes the Render origin. The gateway forwards the OAuth cookie and callback requests to the Worker.

## 4. Update Google OAuth settings

In the Google Cloud OAuth Web Client used by VoxyDB, add these exact **Authorized redirect URIs** (replace the hostname with your Render hostname):

```text
https://voxy-db.onrender.com/api/auth/google/callback
https://voxy-db.onrender.com/api/drive/callback
```

The JavaScript origin is not required for the current redirect-based flow, but you may also add `https://voxy-db.onrender.com` to Authorized JavaScript origins. Save the OAuth client and keep its Client ID/Secret configured as Cloudflare Worker secrets.

## 5. Use the Render URL

Open `https://voxy-db.onrender.com` for the dashboard. Use the same Render URL as `baseUrl` in your SDK clients:

```js
import { VoxyDB } from 'https://voxy-db.onrender.com/voxydb.js';

const db = new VoxyDB({
  baseUrl: 'https://voxy-db.onrender.com',
  projectId: 'YOUR_PROJECT_ID',
  apiKey: 'YOUR_API_KEY'
});
```

The gateway forwards `/api/*`, `/v1/*`, static dashboard assets, and WebSocket connections. Client app CORS allowlists still need the web app's own origin configured for the relevant project API key.

## 6. Updates

Render auto-deploys when the connected Git branch changes. The Cloudflare backend is still deployed separately:

```bash
npm run deploy
```

If the Render domain changes, update `PUBLIC_BASE_URL` in the Worker and both Google OAuth redirect URIs.

## Free-tier and persistence notes

- Render Free Web Services may spin down after 15 minutes without inbound traffic and can take about a minute to wake up.
- Their local filesystem is ephemeral. The gateway stores no database records locally.
- Render free Postgres databases expire after 30 days, so VoxyDB does not use one for its main records.
- Cloudflare D1 and Durable Objects remain the live database and realtime source of truth; their quotas and plan limits apply.

Official references: [Render free services](https://render.com/docs/free), [Render persistent disks](https://render.com/docs/disks), [Render Web Services](https://render.com/docs/web-services).
