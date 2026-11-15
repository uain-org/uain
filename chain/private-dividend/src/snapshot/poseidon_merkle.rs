// Adapted from Valar Group voting-circuits e19c2a4d065b7b369ccd6ccdedcd489e9c0d079c.
// Copyright (c) 2025 Valar Group. MIT license: ../../THIRD-PARTY-LICENSE-MIT.
// UAIN adaptations are experimental and inactive; the pinned upstream audit
// scope does not certify this port, its current dependencies, or this protocol.
//! Shared Poseidon-based Merkle tree gadgets.
//!
//! Provides a conditional swap gate and a full Merkle path synthesis
//! function used by three circuits:
//!
//! - **ZKP #1** (delegation, condition 13): IMT non-membership, depth 29
//! - **ZKP #2** (vote proof, condition 1): VAN membership, depth 24
//! - **ZKP #3** (share reveal, condition 1): VC membership, depth 24
//!
//! The swap gate orders `(current, sibling)` into `(left, right)` based
//! on a position bit, then the path function hashes `Poseidon(left, right)`
//! at each level to walk from a leaf up to the root.
//!
//! The level is intentionally not part of the Poseidon preimage. This matches
//! `vote_commitment_tree::MerkleHashVote::combine`; for the fixed-depth vote
//! commitment tree and IMT, tree integrity comes from consuming exactly
//! `DEPTH` siblings in LSB-first position-bit order. If a future tree becomes
//! sparse, variable-depth, or shares siblings across tree domains, this
//! convention must be revisited and the level should become an explicit hash
//! input, which would require regenerating verifying keys.

use halo2_gadgets::{
    poseidon::{Pow5Chip as PoseidonChip, Pow5Config as PoseidonConfig},
    utilities::bool_check,
};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, Value},
    plonk::{self, Advice, Column, Constraints, Selector},
    poly::Rotation,
};
use orchard::circuit::gadget::assign_free_advice;
use pasta_curves::pallas;

use super::hash::poseidon_hash_in_circuit;

// ================================================================
// MerkleSwapGate
// ================================================================

/// Conditional swap gate for Poseidon Merkle paths.
///
/// **Layout** (1 row, 5 advice columns):
///
/// | Col   | 0       | 1       | 2       | 3    | 4     |
/// |-------|---------|---------|---------|------|-------|
/// | Row 0 | pos_bit | current | sibling | left | right |
///
/// **Constraints**:
/// - `left = current + pos_bit * (sibling - current)`
/// - `left + right = current + sibling` (conservation)
/// - `bool_check(pos_bit)`
#[derive(Clone, Debug)]
pub(crate) struct MerkleSwapGate {
    selector: Selector,
    advices: [Column<Advice>; 5],
}

impl MerkleSwapGate {
    /// Configures the gate on `advices[0..5]`.
    pub(crate) fn configure(
        meta: &mut plonk::ConstraintSystem<pallas::Base>,
        advices: [Column<Advice>; 5],
    ) -> Self {
        let selector = meta.selector();

        meta.create_gate("Merkle conditional swap", |meta| {
            let q = meta.query_selector(selector);
            let pos_bit = meta.query_advice(advices[0], Rotation::cur());
            let current = meta.query_advice(advices[1], Rotation::cur());
            let sibling = meta.query_advice(advices[2], Rotation::cur());
            let left = meta.query_advice(advices[3], Rotation::cur());
            let right = meta.query_advice(advices[4], Rotation::cur());

            Constraints::with_selector(
                q,
                [
                    // pos_bit=0 → left=current; pos_bit=1 → left=sibling.
                    (
                        "swap left",
                        left.clone()
                            - current.clone()
                            - pos_bit.clone() * (sibling.clone() - current.clone()),
                    ),
                    // Conservation: left + right = current + sibling.
                    ("swap right", left + right - current - sibling),
                    // pos_bit must be boolean.
                    ("bool_check pos_bit", bool_check(pos_bit)),
                ],
            )
        });

        MerkleSwapGate { selector, advices }
    }

    /// Assigns a single swap row. Returns `(left, right)`.
    pub(crate) fn assign(
        &self,
        region: &mut halo2_proofs::circuit::Region<'_, pallas::Base>,
        offset: usize,
        pos_bit: &AssignedCell<pallas::Base, pallas::Base>,
        current: &AssignedCell<pallas::Base, pallas::Base>,
        sibling: &AssignedCell<pallas::Base, pallas::Base>,
    ) -> Result<
        (
            AssignedCell<pallas::Base, pallas::Base>,
            AssignedCell<pallas::Base, pallas::Base>,
        ),
        plonk::Error,
    > {
        self.selector.enable(region, offset)?;

        let pos_bit_cell = pos_bit.copy_advice(|| "pos_bit", region, self.advices[0], offset)?;
        let current_cell = current.copy_advice(|| "current", region, self.advices[1], offset)?;
        let sibling_cell = sibling.copy_advice(|| "sibling", region, self.advices[2], offset)?;

        let swap = pos_bit_cell
            .value()
            .copied()
            .zip(current_cell.value().copied())
            .zip(sibling_cell.value().copied())
            .map(|((bit, cur), sib)| {
                if bit == pallas::Base::zero() {
                    (cur, sib)
                } else {
                    (sib, cur)
                }
            });

        let left =
            region.assign_advice(|| "left", self.advices[3], offset, || swap.map(|(l, _)| l))?;

        let right =
            region.assign_advice(|| "right", self.advices[4], offset, || swap.map(|(_, r)| r))?;

        Ok((left, right))
    }
}

// ================================================================
// synthesize_poseidon_merkle_path
// ================================================================

/// Synthesizes a Poseidon Merkle path from `leaf` to the root.
///
/// At each of `DEPTH` levels (LSB-first):
/// 1. Witnesses the position bit and sibling hash.
/// 2. Conditionally swaps via [`MerkleSwapGate`].
/// 3. Hashes `Poseidon(left, right)` with P128Pow5T3.
///
/// The parent hash has no depth or level tag; callers rely on a fixed
/// compile-time `DEPTH` and the position bits to bind each sibling to its level.
///
/// Returns the computed root cell.
/// Synthesizes a Poseidon Merkle path while rotating hash levels across
/// independent Poseidon configurations.
///
/// Level `i` uses configuration `(i + lane_offset) % LANES`.
pub(crate) fn synthesize_poseidon_merkle_path_with_configs<
    const DEPTH: usize,
    const LANES: usize,
>(
    swap_gate: &MerkleSwapGate,
    poseidon_configs: &[PoseidonConfig<pallas::Base, 3, 2>; LANES],
    lane_offset: usize,
    layouter: &mut impl Layouter<pallas::Base>,
    advice_0: Column<Advice>,
    leaf: AssignedCell<pallas::Base, pallas::Base>,
    position: Value<u32>,
    path: Value<[pallas::Base; DEPTH]>,
    label: &str,
) -> Result<AssignedCell<pallas::Base, pallas::Base>, plonk::Error> {
    assert!(LANES > 0, "a Poseidon Merkle path needs at least one lane");
    synthesize_poseidon_merkle_path_with_config_selector(
        swap_gate,
        poseidon_configs,
        |level| (level + lane_offset) % LANES,
        layouter,
        advice_0,
        leaf,
        position,
        path,
        label,
    )
}

fn synthesize_poseidon_merkle_path_with_config_selector<const DEPTH: usize>(
    swap_gate: &MerkleSwapGate,
    poseidon_configs: &[PoseidonConfig<pallas::Base, 3, 2>],
    config_for_level: impl Fn(usize) -> usize,
    layouter: &mut impl Layouter<pallas::Base>,
    advice_0: Column<Advice>,
    leaf: AssignedCell<pallas::Base, pallas::Base>,
    position: Value<u32>,
    path: Value<[pallas::Base; DEPTH]>,
    label: &str,
) -> Result<AssignedCell<pallas::Base, pallas::Base>, plonk::Error> {
    let mut current = leaf;

    for i in 0..DEPTH {
        let pos_bit = assign_free_advice(
            layouter.namespace(|| format!("{label} pos_bit {i}")),
            advice_0,
            position.map(|p| pallas::Base::from(((p >> i) & 1) as u64)),
        )?;

        let sibling = assign_free_advice(
            layouter.namespace(|| format!("{label} sibling {i}")),
            advice_0,
            path.map(|path| path[i]),
        )?;

        let (left, right) = layouter.assign_region(
            || format!("{label} swap level {i}"),
            |mut region| swap_gate.assign(&mut region, 0, &pos_bit, &current, &sibling),
        )?;

        let parent = poseidon_hash_in_circuit(
            PoseidonChip::construct(poseidon_configs[config_for_level(i)].clone()),
            layouter.namespace(|| format!("{label} hash level {i}")),
            "Poseidon(left, right)",
            [left, right],
        )?;

        current = parent;
    }

    Ok(current)
}

// ================================================================
// Unit tests
// ================================================================
