//! `Read + Seek` over a file on the phone, fetched in blocks with `dd`.
//!
//! Lets a zip parser read just an APK's central directory, manifest, resources and icon (a few
//! hundred KB) instead of pulling a 200 MB package over USB.

use crate::adb::{self, shell_quote};
use std::{
    collections::HashMap,
    io::{self, Read, Seek, SeekFrom},
};
use tokio::runtime::Handle;

const BLOCK: u64 = 256 * 1024;
const READAHEAD_BLOCKS: u64 = 8;

pub struct RemoteFile {
    handle: Handle,
    serial: String,
    path: String,
    len: u64,
    pos: u64,
    blocks: HashMap<u64, Vec<u8>>,
    last_block: Option<u64>,
    /// Bytes fetched from the phone so far (for tests and diagnostics).
    pub fetched: u64,
}

impl RemoteFile {
    pub fn new(handle: Handle, serial: &str, path: &str, len: u64) -> Self {
        Self { handle, serial: serial.into(), path: path.into(), len, pos: 0, blocks: HashMap::new(), last_block: None, fetched: 0 }
    }

    fn fetch(&mut self, first: u64, count: u64) -> io::Result<()> {
        let cmd = format!("dd if={} bs={BLOCK} skip={first} count={count} 2>/dev/null", shell_quote(&self.path));
        let data = self.handle.block_on(adb::exec(&self.serial, &cmd)).map_err(|e| io::Error::other(e.to_string()))?;
        self.fetched += data.len() as u64;
        for (i, chunk) in data.chunks(BLOCK as usize).enumerate() {
            self.blocks.insert(first + i as u64, chunk.to_vec());
        }
        Ok(())
    }
}

impl Read for RemoteFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len || buf.is_empty() {
            return Ok(0);
        }
        let b = self.pos / BLOCK;
        if !self.blocks.contains_key(&b) {
            // Sequential access (reading an entry's data) → fetch ahead; random jumps fetch one block.
            let sequential = b > 0 && self.last_block == Some(b - 1);
            let last_block = (self.len - 1) / BLOCK;
            let count = if sequential { READAHEAD_BLOCKS } else { 1 }.min(last_block - b + 1);
            self.fetch(b, count)?;
        }
        self.last_block = Some(b);
        let block = self.blocks.get(&b).ok_or_else(|| io::Error::other("block missing after fetch"))?;
        let off = (self.pos - b * BLOCK) as usize;
        if off >= block.len() {
            return Ok(0);
        }
        let n = buf.len().min(block.len() - off);
        buf[..n].copy_from_slice(&block[off..off + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for RemoteFile {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let new = match from {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(n) => self.len as i128 + n as i128,
            SeekFrom::Current(n) => self.pos as i128 + n as i128,
        };
        if new < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = new as u64;
        Ok(self.pos)
    }
}
