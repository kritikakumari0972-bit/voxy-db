# VoxyDB v0.5.1

VoxyDB is a hosted JSON document database for websites, Android/iOS apps, desktop apps, and server-side services. It provides a management dashboard, Google Sign-In, project-scoped API keys, persistent records, a REST API, a JavaScript SDK, realtime subscriptions, durable change replay, cursor pagination, and retry-safe writes.

## Architecture

- Cloudflare Workers runs the API and dashboard.
- Cloudflare D1 is the primary persistent SQL database.
- Durable Objects provide realtime WebSocket notifications.
- Google Sign-In authenticates dashboard users.
- Google Drive is an optional, separately authorized mirror; it is not the primary database.
- The optional Render Web Service gateway provides a Render public URL and forwards HTTP/WebSocket traffic to the Cloudflare Worker.

## Important deployment note

The complete renamed v0.5.1 source package is being published to this repository. The Render gateway is not a standalone database: deploy the Cloudflare Worker and apply D1 migrations first, then deploy the Render gateway using `render.yaml`. Render's free filesystem is ephemeral, so it must not be used as the primary database.

See the deployment and API documentation in this repository once the full source tree is published.

## Free-tier limits

VoxyDB is free/open-source software, but Cloudflare and Render free-tier quotas, availability, and provider policies apply. Free does not mean unlimited.

## Security

Never commit OAuth client secrets, API keys, Cloudflare tokens, or production environment files. Use provider secrets/environment variables instead.
