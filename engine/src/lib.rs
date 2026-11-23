//! Experimental embedded VoxyDB engine.
//!
//! This single-process engine uses a checksummed append-only WAL and periodic
//! immutable snapshots. It is not yet a distributed or production database.

mod snapshot;
mod wal;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Seek, SeekFrom},
    path::{Path, PathBuf},
};

pub use snapshot::SnapshotError;
pub use wal::WalError;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("WAL error: {0}")]
    Wal(#[from] WalError),
    #[error("snapshot error: {0}")]
    Snapshot(#[from] SnapshotError),
    #[error("invalid key: keys must contain 1 to 1024 non-control characters")]
    InvalidKey,
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Operation {
    Put { key: String, value: Value },
    Delete { key: String },
}

/// Statistics returned after a successful checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckpointStats {
    pub keys: usize,
    pub wal_bytes_before: u64,
    pub snapshot_bytes: u64,
}

/// An embedded database. Exactly one process should own a database directory.
pub struct FileDb {
    directory: PathBuf,
    wal: File,
    index: BTreeMap<String, Value>,
}

impl FileDb {
    /// Open or create a database directory, load its newest snapshot, then
    /// replay the WAL. A corrupt snapshot fails closed instead of being ignored.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, EngineError> {
        let directory = path.as_ref().to_path_buf();
        fs::create_dir_all(&directory)?;
        let mut index = snapshot::load_latest(&directory)?.unwrap_or_default();

        let wal_path = directory.join("data.wal");
        let mut wal = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(wal_path)?;

        let operations = wal::replay_and_repair(&mut wal)?;
        for operation in operations {
            apply(&mut index, operation);
        }
        wal.seek(SeekFrom::End(0))?;

        Ok(Self { directory, wal, index })
    }

    /// Insert or replace a JSON value. The WAL is synced before success returns.
    pub fn put(&mut self, key: impl Into<String>, value: Value) -> Result<(), EngineError> {
        let key = validate_key(key.into())?;
        self.append(Operation::Put { key: key.clone(), value: value.clone() })?;
        self.index.insert(key, value);
        Ok(())
    }

    /// Read a value by key.
    pub fn get(&self, key: &str) -> Result<Option<Value>, EngineError> {
        validate_key(key.to_owned())?;
        Ok(self.index.get(key).cloned())
    }

    /// Delete a key. Deleting a missing key is an idempotent success.
    pub fn delete(&mut self, key: &str) -> Result<bool, EngineError> {
        let key = validate_key(key.to_owned())?;
        let existed = self.index.contains_key(&key);
        if existed {
            self.append(Operation::Delete { key: key.clone() })?;
            self.index.remove(&key);
        }
        Ok(existed)
    }

    /// Return keys beginning with the supplied prefix, in key order, up to limit.
    /// An empty prefix lists from the beginning of the keyspace.
    pub fn scan_prefix(&self, prefix: &str, limit: usize) -> Result<Vec<(String, Value)>, EngineError> {
        if prefix.len() > 1024 || prefix.chars().any(char::is_control) {
            return Err(EngineError::InvalidKey);
        }
        let rows = self.index
            .range(prefix.to_owned()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .take(limit)
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        Ok(rows)
    }

    /// Number of live keys currently indexed in memory.
    pub fn len(&self) -> usize {
        self.index.len()
    }

    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    /// Location of this database's files.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Persist a compact snapshot and then reset the WAL.
    ///
    /// If the process stops after the snapshot is installed but before the WAL
    /// is truncated, replaying the old ordered log is safe because its final
    /// state is already represented by the snapshot. Only one process may own
    /// a database directory at a time.
    pub fn checkpoint(&mut self) -> Result<CheckpointStats, EngineError> {
        let wal_bytes_before = self.wal.metadata()?.len();
        let snapshot_path = snapshot::write_new(&self.directory, &self.index)?;
        let snapshot_bytes = fs::metadata(snapshot_path)?.len();

        self.wal.set_len(0)?;
        self.wal.seek(SeekFrom::Start(0))?;
        self.wal.sync_all()?;

        Ok(CheckpointStats {
            keys: self.index.len(),
            wal_bytes_before,
            snapshot_bytes,
        })
    }

    /// Current WAL size in bytes (does not include snapshots).
    pub fn wal_size_bytes(&self) -> Result<u64, EngineError> {
        Ok(self.wal.metadata()?.len())
    }

    fn append(&mut self, operation: Operation) -> Result<(), EngineError> {
        wal::append(&mut self.wal, &operation)?;
        Ok(())
    }
}

fn validate_key(key: String) -> Result<String, EngineError> {
    if key.is_empty() || key.len() > 1024 || key.chars().any(char::is_control) {
        return Err(EngineError::InvalidKey);
    }
    Ok(key)
}

fn apply(index: &mut BTreeMap<String, Value>, operation: Operation) {
    match operation {
        Operation::Put { key, value } => {
            index.insert(key, value);
        }
        Operation::Delete { key } => {
            index.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persists_put_update_and_delete_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut db = FileDb::open(dir.path()).unwrap();
            db.put("user:1", json!({"name":"Asha","active":true})).unwrap();
            db.put("user:1", json!({"name":"Asha","active":false})).unwrap();
            db.put("user:2", json!([1, 2, 3])).unwrap();
            assert_eq!(db.len(), 2);
            assert!(db.delete("user:2").unwrap());
            assert!(!db.delete("user:2").unwrap());
        }
        let db = FileDb::open(dir.path()).unwrap();
        assert_eq!(db.get("user:1").unwrap(), Some(json!({"name":"Asha","active":false})));
        assert_eq!(db.get("user:2").unwrap(), None);
        assert_eq!(db.len(), 1);
    }

    #[test]
    fn checkpoint_compacts_wal_and_survives_reopen_and_later_writes() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut db = FileDb::open(dir.path()).unwrap();
            db.put("user:1", json!({"name":"Asha"})).unwrap();
            db.put("user:1", json!({"name":"Asha","active":true})).unwrap();
            db.put("user:2", json!({"name":"Ravi"})).unwrap();
            let stats = db.checkpoint().unwrap();
            assert_eq!(stats.keys, 2);
            assert!(stats.wal_bytes_before > 0);
            assert!(stats.snapshot_bytes > 0);
            assert_eq!(db.wal_size_bytes().unwrap(), 0);
            db.put("user:3", json!({"name":"Mina"})).unwrap();
        }
        let db = FileDb::open(dir.path()).unwrap();
        assert_eq!(db.len(), 3);
        assert_eq!(db.get("user:1").unwrap(), Some(json!({"name":"Asha","active":true})));
        assert_eq!(db.get("user:3").unwrap(), Some(json!({"name":"Mina"})));
    }

    #[test]
    fn snapshot_before_wal_reset_recovers_after_simulated_crash() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut db = FileDb::open(dir.path()).unwrap();
            db.put("account:1", json!({"balance":10})).unwrap();
            db.put("account:1", json!({"balance":25})).unwrap();
            // Simulate a process stopping after the snapshot is installed but
            // before checkpoint truncates the existing WAL.
            snapshot::write_new(db.directory(), &db.index).unwrap();
            assert!(db.wal_size_bytes().unwrap() > 0);
        }
        let db = FileDb::open(dir.path()).unwrap();
        assert_eq!(db.get("account:1").unwrap(), Some(json!({"balance":25})));
    }

    #[test]
    fn opening_a_corrupt_latest_snapshot_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut db = FileDb::open(dir.path()).unwrap();
            db.put("item:1", json!({"value":"safe"})).unwrap();
            db.checkpoint().unwrap();
        }
        let snapshot_path = fs::read_dir(dir.path()).unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|extension| extension == "vxs"))
            .unwrap();
        let mut bytes = fs::read(&snapshot_path).unwrap();
        bytes[24] ^= 0x01;
        fs::write(&snapshot_path, bytes).unwrap();

        assert!(matches!(
            FileDb::open(dir.path()),
            Err(EngineError::Snapshot(SnapshotError::ChecksumMismatch))
        ));
    }

    #[test]
    fn prefix_scan_is_sorted_and_limited() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = FileDb::open(dir.path()).unwrap();
        db.put("user:3", json!(3)).unwrap();
        db.put("team:1", json!(1)).unwrap();
        db.put("user:1", json!(1)).unwrap();
        db.put("user:2", json!(2)).unwrap();
        let rows = db.scan_prefix("user:", 2).unwrap();
        assert_eq!(rows, vec![("user:1".into(), json!(1)), ("user:2".into(), json!(2))]);
        assert_eq!(db.scan_prefix("", 1).unwrap().len(), 1);
    }

    #[test]
    fn rejects_invalid_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = FileDb::open(dir.path()).unwrap();
        assert!(matches!(db.put("", json!(1)), Err(EngineError::InvalidKey)));
        assert!(matches!(db.get("bad\nkey"), Err(EngineError::InvalidKey)));
    }
}
