# Security policy

VoxyDB is an early-stage database service and has not been independently audited. Do not use this release for highly sensitive production data.

## Current controls

- Google Sign-In uses Authorization Code flow with PKCE, state, nonce, HTTPS-only HttpOnly cookies, and server-side ID-token signature/claim validation.
- VoxyDB console sessions are random, stored as SHA-256 hashes, and delivered in `HttpOnly; Secure; SameSite=Lax` cookies.
- Dashboard write requests require a same-origin `Origin` header.
- Project ownership is checked on dashboard project routes; project API keys are random, stored as SHA-256 hashes, scoped to read/write operations, revocable, and optionally restricted to exact HTTP origins.
- SQL uses D1 prepared statements and bound parameters.
- Request bodies and record sizes are bounded; collection names are validated.
- Google Drive storage uses a separate authorization flow limited to `drive.file`; Google Sign-In and Drive storage permissions are not conflated.
- Drive refresh tokens are encrypted using AES-GCM before storage in D1. Access tokens are refreshed server-side and are never returned to clients.
- In Drive-mirror mode, the record mutation and outbox job commit together in a D1 batch transaction. Retry jobs use leases and capped exponential backoff.
- Realtime tickets are random, short-lived, single-use, and stored only as hashes. Permanent API keys are exchanged over HTTPS and are not placed in WebSocket URLs.
- Realtime WebSockets are read-only. All record mutations go through the normal authenticated REST API and publish events only after the D1 commit.
- The durable change log is written in the same D1 batch as each record mutation. SDK clients can replay missed changes for seven days and receive `CURSOR_EXPIRED` when a fresh snapshot is required.
- Mutation idempotency responses are stored with the same D1 batch and expire after 24 hours.
- A restrictive Content Security Policy and basic browser security headers are applied to dashboard assets.

## Known limitations

- Google Drive is file storage, not a native SQL database. D1 is the primary store; Drive mirrors are asynchronous and can temporarily lag while queued jobs retry.
- Manual edits to JSON files in Drive are not imported back to VoxyDB in this release.
- Change history is retained for seven days. Apps offline longer than that must fetch a fresh collection snapshot after receiving `CURSOR_EXPIRED`.
- A Drive API outage does not roll back an already committed D1 write; it leaves a pending outbox job. Monitor the dashboard's pending sync count.
- Drive storage, D1, Workers, Durable Objects, and API quotas are provider-controlled and may change.
- The admin console is currently a single account workspace, not an organization/team collaboration system.
- App API keys are project-level. A leaked write key can modify or delete all records reachable in that project.
- CORS origin allowlists are not authentication. Non-browser clients can forge an `Origin` header.
- Automated integration tests use a local SQLite-backed D1 adapter; no live Cloudflare staging test, load test, high-concurrency race test, independent penetration test or formal security audit has been completed.

## Operational requirements

1. Store `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and (when Drive is enabled) `DRIVE_TOKEN_ENCRYPTION_KEY` in Cloudflare Worker Secrets only.
2. Keep `DRIVE_TOKEN_ENCRYPTION_KEY` stable. Losing or rotating it without reconnecting Drive makes previously encrypted refresh tokens unreadable.
3. Never commit `.dev.vars`, OAuth client secrets, encryption keys, or raw `ndb_live_` API keys.
4. Use read-only API keys in browser/mobile public clients. Keep write keys on a trusted server.
5. Restrict origins for API keys used by browser apps, and revoke exposed keys immediately.
6. Review Cloudflare and Google quotas, enable appropriate backups, and verify disaster-recovery procedures before storing important data.
7. Do not store passwords, payment details, private identity data, medical information, or other highly sensitive personal data in this early release.
8. Do not revoke Google Drive permission while projects still rely on Drive mirroring; switch those projects back to D1 first.

## Reporting

Once the repository is published and private security advisories are enabled, report vulnerabilities through GitHub Security Advisories. Do not publish credentials or private data in public issues.
