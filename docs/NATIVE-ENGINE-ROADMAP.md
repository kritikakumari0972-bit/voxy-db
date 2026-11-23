# VoxyDB Native Engine Roadmap

## Direction

VoxyDB will evolve toward a provider-independent database engine. The existing
Cloudflare Worker + D1 service remains the current hosted backend while the
native engine is developed and validated separately.

## Storage roles

- **Primary live storage:** local SSD/NVMe or disks attached to self-hosted nodes.
- **Distributed live storage:** VoxyDB-managed nodes with partitioning,
  replication, health checks and recovery.
- **External file providers:** GitHub, Google Drive and Hugging Face are
  connectors for exports, snapshots, archives and low-write workflows. They
  are not treated as low-latency transactional disks.
- **Capacity:** no hard-coded product-wide byte ceiling; usable capacity is
  bounded by connected hardware, provider quotas, replication overhead and
  operational limits.

## Milestones

1. **Embedded WAL engine:** durable single-process key/value store and replay.
2. **Checkpoint and ordered key index (current):** checksummed snapshots,
   checkpoint recovery, WAL reset and bounded prefix scans.
3. **Segment storage:** immutable sorted data segments, manifests and
   compaction with crash-safe installation.
4. **Query layer:** secondary JSON-field indexes, filtering, sorting and
   pagination.
5. **Transactions:** atomic multi-key batches, MVCC and isolation tests.
6. **Server and SDK:** authenticated network API, connection management,
   TypeScript/Python clients and observability.
7. **Provider connectors:** snapshot export/import and verified restore for
   GitHub, Drive, Hugging Face and S3-compatible object storage.
8. **Distributed cluster:** shard placement, Raft-based metadata/leadership,
   replication, rebalancing and node recovery.
9. **Production hardening:** fuzzing, fault injection, benchmarks, security
   review, backup drills and migration tooling.

## Non-goals and honest guarantees

- No literal unlimited storage, throughput, availability or free compute.
- Git repositories and consumer cloud-drive APIs are not used for every live
  record write.
- A feature is not production-ready until tests, load measurements, failure
  tests and documented operational limits exist.
- The native engine must not replace the hosted D1 backend until migration,
  consistency and disaster-recovery paths are tested.
