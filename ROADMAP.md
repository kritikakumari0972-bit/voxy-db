# VoxyDB roadmap

## v0.1.0 — Core database starter (complete)
- [x] Cloudflare Worker + D1 deployment layout
- [x] Projects, collections, persistent JSON records
- [x] Scoped and revocable project API keys
- [x] REST CRUD endpoints and browser helper
- [x] Database dashboard for projects, data, keys, and API examples

## v0.2.0 — Google Drive record storage (complete as an optional mirror)
- [x] Limited Google Drive `drive.file` storage authorization
- [x] Encrypted refresh-token storage using AES-GCM
- [x] App-managed Drive folder and JSON file per record
- [x] Resumable D1-to-Drive migration

## v0.3.0 — Database console hardening (historical)
- [x] Intermediate password-only console release was superseded
- [x] Google Sign-In restored in v0.4.0
- [x] Drive disconnect protection

## v0.4.0 — Google identity, durable Drive mirror, and realtime (complete)
- [x] Google Sign-In; separate optional Drive authorization
- [x] D1 primary records and transactional Drive outbox
- [x] Background Drive sync with retry/backoff and job leases
- [x] Durable Objects WebSocket fan-out per project/collection
- [x] Short-lived, single-use realtime tickets
- [x] Browser SDK `subscribe()` helper and dashboard live updates

## v0.5.0 — App integration and reliable synchronization (implemented; staging deployment pending)
- [x] Durable change log written atomically with record mutations
- [x] Reconnect replay from the last confirmed collection cursor
- [x] Seven-day event retention with expired-cursor detection
- [x] Cursor pagination for record listing
- [x] 24-hour idempotency keys for retry-safe writes
- [x] JavaScript SDK for CRUD, pagination, retry and realtime subscriptions
- [x] Samples for vanilla JS, React, Node.js, Python, Kotlin and Flutter
- [x] One-command guided Cloudflare setup and deployment
- [x] Automated worker, SDK, SQLite integration and retention tests
- [ ] Real Cloudflare staging deployment and live Google OAuth/Drive test
- [ ] Indexed filter/query builder and collection-level access rules
- [ ] Usage analytics, request quotas and audit-log UI
- [ ] Scheduled export/restore drill and Drive orphan reconciliation

## v1.0.0 — Production readiness
- [ ] Independent threat model and security review
- [ ] Load, failure-injection and high-concurrency race testing
- [ ] Multi-user teams and role-based project administration
- [ ] Verified backup and disaster-recovery procedures
- [ ] Project/collection deletion and recovery workflows


## v0.5.1 completed

- Added optional Render Web Service gateway with HTTP, cookie, OAuth callback, and WebSocket upgrade forwarding to Cloudflare Workers.
- Added `PUBLIC_BASE_URL` for public OAuth redirect URLs and same-origin dashboard validation.
- Added Render Blueprint, deployment guide, health endpoint and gateway integration tests.
