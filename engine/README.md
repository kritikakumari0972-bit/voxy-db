# VoxyDB Embedded Engine (experimental)

This crate is the first step toward a native VoxyDB storage engine. It is an
embedded, single-process key/value store backed by an append-only write-ahead
log (WAL).

## Current guarantees

- A successful mutation is appended and synced before the in-memory index changes.
- The log is replayed on open.
- An incomplete final frame is treated as a torn tail and truncated safely.
- A checksum mismatch in a complete frame is reported as corruption; it is not
  silently discarded.
- Values are JSON objects/scalars supported by serde_json.

## Current limitations

This is an experimental single-process engine, not a production distributed
database. It has no multi-process locking, transactions across multiple keys,
compaction, encryption, replication, query planner, or network server yet.
Do not use it as the only copy of important data.

## Run

From this directory:

```bash
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

The runtime is deliberately separate from the existing Cloudflare Worker. The
Worker currently uses D1 as its transactional source of truth; this crate does
not replace that backend until compatibility, migration, and recovery tests
are implemented.
