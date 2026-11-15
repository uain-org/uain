//! Full-domain versioned spent-nullifier sparse tree. No artificial sentinels.
//! This constructor is a deterministic witness helper, not native-state authentication.
use super::hash::poseidon_hash_3;
use pasta_curves::{group::ff::PrimeField, pallas};
use std::collections::{BTreeMap, BTreeSet};
type F = pallas::Base;
pub const DEPTH: usize = 256;
// ASCII-derived, versioned, disjoint field tags. Tree levels are part of every node hash.
const EMPTY_TAG: u64 = 0x5541494e534d0100;
const LEAF_TAG: u64 = 0x5541494e534d0200;
const NODE_TAG: u64 = 0x5541494e534d0300;
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TreeError {
    NonCanonical,
    Duplicate,
    PathLength,
}
pub fn canonical(bytes: [u8; 32]) -> Result<F, TreeError> {
    Option::<F>::from(F::from_repr(bytes)).ok_or(TreeError::NonCanonical)
}
pub fn empty_leaf() -> F {
    poseidon_hash_3(F::from(EMPTY_TAG), F::zero(), F::zero())
}
pub fn occupied_leaf(key: [u8; 32]) -> Result<F, TreeError> {
    Ok(poseidon_hash_3(
        F::from(LEAF_TAG),
        canonical(key)?,
        F::one(),
    ))
}
pub fn node(level: usize, left: F, right: F) -> F {
    assert!(level < DEPTH);
    poseidon_hash_3(F::from(NODE_TAG + level as u64), left, right)
}
pub fn node_domain(level: usize) -> F {
    assert!(level < DEPTH);
    F::from(NODE_TAG + level as u64)
}
fn parent(mut p: [u8; 32]) -> [u8; 32] {
    for i in 0..32 {
        p[i] = (p[i] >> 1) | if i < 31 { p[i + 1] << 7 } else { 0 };
    }
    p
}
fn sibling(mut p: [u8; 32]) -> [u8; 32] {
    p[0] ^= 1;
    p
}
/// O(256) insertion and path construction, O(n*256) public storage bound.
/// Native state must atomically apply EVERY accepted spend before snapshotting.
#[derive(Clone)]
pub struct SparseTree {
    nodes: BTreeMap<(usize, [u8; 32]), F>,
    keys: BTreeSet<[u8; 32]>,
    empty: Vec<F>,
}
impl Default for SparseTree {
    fn default() -> Self {
        Self::new()
    }
}
impl SparseTree {
    pub fn new() -> Self {
        let mut empty = vec![empty_leaf()];
        for level in 0..DEPTH {
            empty.push(node(level, empty[level], empty[level]));
        }
        Self {
            nodes: BTreeMap::new(),
            keys: BTreeSet::new(),
            empty,
        }
    }
    pub fn root(&self) -> F {
        self.get(DEPTH, [0; 32])
    }
    pub fn count(&self) -> usize {
        self.keys.len()
    }
    fn get(&self, level: usize, index: [u8; 32]) -> F {
        self.nodes
            .get(&(level, index))
            .copied()
            .unwrap_or(self.empty[level])
    }
    pub fn path(&self, key: [u8; 32]) -> Result<Vec<F>, TreeError> {
        canonical(key)?;
        let mut p = key;
        Ok((0..DEPTH)
            .map(|level| {
                let s = self.get(level, sibling(p));
                p = parent(p);
                s
            })
            .collect())
    }
    pub fn insert(&mut self, key: [u8; 32]) -> Result<(), TreeError> {
        let mut cur = occupied_leaf(key)?;
        if !self.keys.insert(key) {
            return Err(TreeError::Duplicate);
        }
        let mut p = key;
        self.nodes.insert((0, p), cur);
        for level in 0..DEPTH {
            let s = self.get(level, sibling(p));
            cur = if p[0] & 1 == 0 {
                node(level, cur, s)
            } else {
                node(level, s, cur)
            };
            p = parent(p);
            self.nodes.insert((level + 1, p), cur);
        }
        Ok(())
    }
}
pub fn verify_absence(root: F, key: [u8; 32], path: &[F]) -> Result<bool, TreeError> {
    if path.len() != DEPTH {
        return Err(TreeError::PathLength);
    }
    canonical(key)?;
    let mut cur = empty_leaf();
    let mut p = key;
    for (level, s) in path.iter().enumerate() {
        cur = if p[0] & 1 == 0 {
            node(level, cur, *s)
        } else {
            node(level, *s, cur)
        };
        p = parent(p);
    }
    Ok(cur == root)
}
#[cfg(test)]
mod tests;
