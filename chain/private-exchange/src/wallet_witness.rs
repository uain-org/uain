//! Compact paths supplied by the pinned finalized-state reader. Ownership and
//! the path's root are independently checked by each wallet before proving.
use incrementalmerkletree::Hashable;
use orchard::tree::{MerkleHashOrchard, MerklePath};
use serde::Deserialize;
use std::io;
type E = Box<dyn std::error::Error>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactWitness {
    pub position: u32,
    pub commitment: String,
    pub path: [String; 32],
}
fn invalid() -> E {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid compact witness").into()
}
pub fn count(value: &str) -> Result<u64, E> {
    let n: u64 = value.parse()?;
    if n > (1u64 << 32) || n.to_string() != value {
        return Err(invalid());
    }
    Ok(n)
}
pub fn path(w: &CompactWitness, position: u32, note_count: &str) -> Result<MerklePath, E> {
    if position != w.position || u64::from(position) >= count(note_count)? {
        return Err(invalid());
    }
    let mut path = [MerkleHashOrchard::empty_leaf(); 32];
    for (i, text) in w.path.iter().enumerate() {
        if text.len() != 64
            || text
                .bytes()
                .any(|b| !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        let bytes: [u8; 32] = hex::decode(text)?.try_into().map_err(|_| invalid())?;
        path[i] = Option::from(MerkleHashOrchard::from_bytes(&bytes)).ok_or_else(invalid)?;
    }
    Ok(MerklePath::from_parts(position, path))
}
