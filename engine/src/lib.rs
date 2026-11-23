//! Experimental embedded VoxyDB engine.
//!
//! This first version provides durable single-key mutations using an
//! append-only WAL. It is intentionally small and does not claim to be a
//! distributed or production-ready database.

mod wal;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

pub use wal::WalError;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("WAL error: {0}")]
    Wal(#[from] WalError),
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

/// A small embedded database. One process should own a database directory.
pub struct FileDb {
    directory: PathBuf,
    wal: File,
    index: BTreeMap<String, Value>,
}

impl FileDb {
    /// Open or create a database directory and replay its WAL.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, EngineError> {
        let directory = path.as_ref().to_path_buf();
        fs::create_dir_all(&directory)?;
        let wal_path = directory.join("data.wal");
        let mut wal = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(wal_path)?;

        let operations = wal::replay_and_repair(&mut wal)?;
        let mut index = BTreeMap::new();
        for operation in operations {
            apply(&mut index, operation);
        }
        wal.seek(std::io::SeekFrom::End(0))?;

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
    fn rejects_invalid_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = FileDb::open(dir.path()).unwrap();
        assert!(matches!(db.put("", json!(1)), Err(EngineError::InvalidKey)));
        assert!(matches!(db.get("bad\nkey"), Err(EngineError::InvalidKey)));
    }
}
