# VoxyDB Embedded Engine (experimental)

This crate is the first step toward a native VoxyDB storage engine. It is an
embedded, single-process key/value store backed by a checksummed append-only
write-ahead log (WAL) and versioned snapshots.

## Current guarantees

- A successful mutation is appended and synced before the in-memory index changes.
- The newest snapshot is checksum-validated and loaded before WAL replay.
- Checkpoints write and sync a new snapshot before truncating the WAL.
- If a process stops after snapshot creation but before WAL truncation, replaying
  the old ordered log produces the same final state.
- An incomplete final WAL frame is treated as a torn tail and truncated safely.
- A checksum mismatch in a complete WAL frame or snapshot is reported as
  corruption; it is not silently discarded.
- Prefix scans use the ordered in-memory key index.

## Basic use

Create a FileDb, call put/get, then use scan_prefix for ordered key scans.
Call checkpoint periodically to write a recovery snapshot and reset the WAL.

## Run

From this directory, run cargo test, cargo fmt --check, and
cargo clippy --all-targets -- -D warnings.

## Current limitations

This is experimental single-process storage, not a production distributed
database. One process must own a database directory. It has no inter-process
locking, atomic multi-key transactions, secondary JSON-field indexes, segment
files, encryption, replication, or network server yet. Snapshots currently
remain on disk as versioned recovery points; retention/garbage collection is
still to be implemented.

The runtime is deliberately separate from the existing Cloudflare Worker. The
Worker currently uses D1 as its transactional source of truth; this crate does
not replace that backend until compatibility, migration, and recovery tests
are implemented.
