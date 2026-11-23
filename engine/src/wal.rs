use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
};

const HEADER_BYTES: u64 = 8;
const MAX_FRAME_BYTES: u32 = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum WalError {
    #[error("WAL I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("WAL frame is too large")]
    FrameTooLarge,
    #[error("WAL checksum mismatch at byte offset {0}")]
    ChecksumMismatch(u64),
    #[error("invalid WAL operation at byte offset {0}")]
    InvalidOperation(u64),
}

/// Append one checksummed frame and sync it before returning.
pub fn append<T: Serialize>(file: &mut File, value: &T) -> Result<(), WalError> {
    let payload = serde_json::to_vec(value)
        .map_err(|_| WalError::InvalidOperation(0))?;
    let length = u32::try_from(payload.len()).map_err(|_| WalError::FrameTooLarge)?;
    if length > MAX_FRAME_BYTES {
        return Err(WalError::FrameTooLarge);
    }
    let checksum = crc32fast::hash(&payload);
    file.write_all(&length.to_le_bytes())?;
    file.write_all(&checksum.to_le_bytes())?;
    file.write_all(&payload)?;
    file.sync_data()?;
    Ok(())
}

/// Replay complete frames. Only an incomplete final frame is truncated.
pub fn replay_and_repair<T: DeserializeOwned>(file: &mut File) -> Result<Vec<T>, WalError> {
    file.seek(SeekFrom::Start(0))?;
    let file_length = file.metadata()?.len();
    let mut offset = 0_u64;
    let mut output = Vec::new();

    while offset < file_length {
        let remaining = file_length - offset;
        if remaining < HEADER_BYTES {
            file.set_len(offset)?;
            break;
        }

        let mut header = [0_u8; 8];
        file.read_exact(&mut header)?;
        let length = u32::from_le_bytes(header[0..4].try_into().expect("fixed slice"));
        let expected_crc = u32::from_le_bytes(header[4..8].try_into().expect("fixed slice"));
        if length > MAX_FRAME_BYTES {
            return Err(WalError::FrameTooLarge);
        }

        let frame_end = offset + HEADER_BYTES + u64::from(length);
        if frame_end > file_length {
            file.set_len(offset)?;
            break;
        }

        let mut payload = vec![0_u8; length as usize];
        file.read_exact(&mut payload)?;
        if crc32fast::hash(&payload) != expected_crc {
            return Err(WalError::ChecksumMismatch(offset));
        }
        let operation = serde_json::from_slice(&payload)
            .map_err(|_| WalError::InvalidOperation(offset))?;
        output.push(operation);
        offset = frame_end;
    }

    file.seek(SeekFrom::End(0))?;
    Ok(output)
}
