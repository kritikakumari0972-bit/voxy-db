//! Versioned, checksummed snapshots used to compact the append-only WAL.

use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const MAGIC: &[u8; 8] = b"VOXYDB01";
const FORMAT_VERSION: u32 = 1;
const HEADER_BYTES: usize = 24;

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("snapshot I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("snapshot JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("snapshot header is truncated")]
    Truncated,
    #[error("snapshot magic does not match this database format")]
    InvalidMagic,
    #[error("unsupported snapshot version: {0}")]
    UnsupportedVersion(u32),
    #[error("snapshot payload length does not match the file")]
    InvalidLength,
    #[error("snapshot checksum mismatch")]
    ChecksumMismatch,
    #[error("snapshot generation counter is exhausted")]
    GenerationOverflow,
}

fn parse_generation(name: &str) -> Option<u64> {
    name.strip_prefix("snapshot-")?
        .strip_suffix(".vxs")?
        .parse()
        .ok()
}

fn newest_snapshot(directory: &Path) -> Result<Option<(u64, PathBuf)>, SnapshotError> {
    let mut newest: Option<(u64, PathBuf)> = None;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(generation) = parse_generation(&name.to_string_lossy()) else {
            continue;
        };
        if newest.as_ref().is_none_or(|(current, _)| generation > *current) {
            newest = Some((generation, entry.path()));
        }
    }
    Ok(newest)
}

pub fn load_latest(directory: &Path) -> Result<Option<BTreeMap<String, Value>>, SnapshotError> {
    match newest_snapshot(directory)? {
        Some((_, path)) => load(&path).map(Some),
        None => Ok(None),
    }
}

pub fn write_new(
    directory: &Path,
    values: &BTreeMap<String, Value>,
) -> Result<PathBuf, SnapshotError> {
    let generation = newest_snapshot(directory)?
        .map(|(generation, _)| generation)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(SnapshotError::GenerationOverflow)?;

    let payload = serde_json::to_vec(values)?;
    let length = u64::try_from(payload.len()).map_err(|_| SnapshotError::InvalidLength)?;
    let checksum = crc32fast::hash(&payload);
    let filename = format!("snapshot-{generation:020}.vxs");
    let final_path = directory.join(&filename);
    let temp_path = directory.join(format!(".snapshot-{generation:020}.tmp"));

    // A leftover temporary file was never installed as a snapshot and can be
    // safely removed before retrying this generation.
    let _ = fs::remove_file(&temp_path);
    let write_result = (|| -> Result<(), SnapshotError> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp_path)?;
        file.write_all(MAGIC)?;
        file.write_all(&FORMAT_VERSION.to_le_bytes())?;
        file.write_all(&length.to_le_bytes())?;
        file.write_all(&checksum.to_le_bytes())?;
        file.write_all(&payload)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp_path, &final_path)?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result?;
    Ok(final_path)
}

fn load(path: &Path) -> Result<BTreeMap<String, Value>, SnapshotError> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < HEADER_BYTES as u64 {
        return Err(SnapshotError::Truncated);
    }

    let mut header = [0_u8; HEADER_BYTES];
    file.read_exact(&mut header)?;
    if &header[0..8] != MAGIC {
        return Err(SnapshotError::InvalidMagic);
    }
    let version = u32::from_le_bytes(header[8..12].try_into().expect("fixed slice"));
    if version != FORMAT_VERSION {
        return Err(SnapshotError::UnsupportedVersion(version));
    }
    let payload_len = u64::from_le_bytes(header[12..20].try_into().expect("fixed slice"));
    let expected_checksum = u32::from_le_bytes(header[20..24].try_into().expect("fixed slice"));
    if payload_len != file_len - HEADER_BYTES as u64 {
        return Err(SnapshotError::InvalidLength);
    }

    let payload_size = usize::try_from(payload_len).map_err(|_| SnapshotError::InvalidLength)?;
    let mut payload = Vec::new();
    payload.try_reserve_exact(payload_size).map_err(|_| SnapshotError::InvalidLength)?;
    payload.resize(payload_size, 0);
    file.read_exact(&mut payload)?;
    if crc32fast::hash(&payload) != expected_checksum {
        return Err(SnapshotError::ChecksumMismatch);
    }
    Ok(serde_json::from_slice(&payload)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_and_reads_latest_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut values = BTreeMap::new();
        values.insert("a".to_owned(), json!({"value":1}));
        write_new(dir.path(), &values).unwrap();
        values.insert("b".to_owned(), json!({"value":2}));
        write_new(dir.path(), &values).unwrap();
        assert_eq!(load_latest(dir.path()).unwrap(), Some(values));
    }

    #[test]
    fn rejects_modified_snapshot_payload() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_new(dir.path(), &BTreeMap::new()).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        bytes[HEADER_BYTES] ^= 0xff;
        fs::write(&path, bytes).unwrap();
        assert!(matches!(load_latest(dir.path()), Err(SnapshotError::ChecksumMismatch)));
    }
}
