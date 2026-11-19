# Deploy VoxyDB to Cloudflare from GitHub

This workflow deploys the live VoxyDB backend. It creates or reuses the D1 database in the Asia-Pacific region, applies the checked-in SQL migrations, deploys the Worker and stores Google Sign-In secrets in Cloudflare. Google Drive stays optional.

## 1. Add GitHub Actions secrets

Before dispatching the workflow, open Cloudflare **Workers & Pages** and enable your account's `workers.dev` subdomain if it is not already enabled. Create a Google OAuth 2.0 client of type **Web application** in Google Cloud.\n\nOpen the repository's **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Account API token with Workers product **Admin** (needed to create the first Worker) and D1 **Edit** access. Scope it to the one Cloudflare account where possible. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Web Client ID ending in `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Matching Google OAuth Web Client secret |
| `DRIVE_TOKEN_ENCRYPTION_KEY` | Optional. A random secret of at least 32 characters; only add it to enable the separate Google Drive mirror. |

Do not paste these values into chat, commit them to Git, or put them in a source file. Keep the Cloudflare token account-scoped and avoid granting unrelated access.

Cloudflare permissions change as its Developer Platform roles evolve. The token needs permission to create a Worker on first deployment, write the D1 database/migrations, and deploy Worker secrets. After the Worker exists, its deployment permission can be narrowed to the VoxyDB Worker.

## 2. Run the deployment

1. Open the repository's **Actions** tab.
2. Select **Deploy VoxyDB to Cloudflare**.
3. Choose **Run workflow** on `main`.
4. Open the run and check that source validation, D1 migrations and Worker deployment all pass.

The workflow commits the generated D1 database ID to `wrangler.jsonc`; that ID is configuration, not a secret. The Worker name is `voxy-db` and the D1 database is `voxydb-production`.

## 3. Finish Google Sign-In

The successful workflow log prints the deployed `workers.dev` URL. In the Google Cloud OAuth Web Client, add this Authorized redirect URI using that exact hostname:

```text
https://YOUR-WORKER.workers.dev/api/auth/google/callback
```

If optional Drive mirroring is enabled, also add:

```text
https://YOUR-WORKER.workers.dev/api/drive/callback
```

If the Google OAuth consent screen is in Testing mode, add the account that will sign in as a test user. Then open the Worker URL and verify that **Continue with Google** works.

## 4. Optional Render gateway

Deploy the Worker first. Then connect the repository to Render as a Blueprint and set `CLOUDFLARE_WORKER_URL` to the Worker origin. Set `PUBLIC_BASE_URL` on the Cloudflare Worker to the Render URL and update the Google OAuth redirect URIs to the Render hostname. See [RENDER.md](RENDER.md).

The Render service is only a gateway. Cloudflare D1 remains the database and SQLite-backed Durable Objects provide realtime delivery. Render's free service can sleep while idle; it is not 24/7 always-on hosting.

## Repeat deployments

Run **Deploy VoxyDB to Cloudflare** again after merging changes that affect the Worker or migrations. D1 migrations are applied before each deployment, and already-applied migrations are not reapplied.
