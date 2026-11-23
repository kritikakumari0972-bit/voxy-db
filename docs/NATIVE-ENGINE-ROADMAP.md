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

1. **Embedded WAL engine (current):** durable single-process key/value store,
   replay, torn-tail repair and checksummed frames.
2. **Segment storage:** immutable data segments, manifests, compaction and
   snapshot creation.
3. **Indexes and query layer:** key indexes, secondary indexes, filtering,
   pagination and query planning.
4. **Transactions:** atomic multi-key batches, MVCC and isolation tests.
5. **Server and SDK:** authenticated network API, connection management,
   TypeScript/Python clients and observability.
6. **Provider connectors:** snapshot export/import and verified restore for
   GitHub, Drive, Hugging Face and S3-compatible object storage.
7. **Distributed cluster:** shard placement, Raft-based metadata/leadership,
   replication, rebalancing and node recovery.
8. **Production hardening:** fuzzing, fault injection, benchmarks, security
   review, backup drills and migration tooling.

## Non-goals and honest guarantees

- No literal unlimited storage, throughput, availability or free compute.
- Git repositories and consumer cloud-drive APIs are not used for every live
  record write.
- A feature is not production-ready until tests, load measurements, failure
  tests and documented operational limits exist.
- The native engine must not replace the hosted D1 backend until migration,
  consistency and disaster-recovery paths are tested.
