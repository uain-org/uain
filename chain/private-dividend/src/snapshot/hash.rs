// Adapted from Valar Group voting-circuits e19c2a4d065b7b369ccd6ccdedcd489e9c0d079c.
// Copyright (c) 2025 Valar Group. MIT license: ../../THIRD-PARTY-LICENSE-MIT.
// UAIN adaptations are experimental and inactive; the pinned upstream audit
// scope does not certify this port, its current dependencies, or this protocol.
//! Canonical Poseidon primitives used by protocol hash helpers.
//!
//! These wrappers centralize the P128Pow5T3, width 3, rate 2 parameters so
//! native helpers, in-circuit gadgets, and test oracles cannot drift into
//! separate definitions.

use halo2_gadgets::poseidon::{
    primitives::{self as poseidon, ConstantLength},
    Hash as PoseidonHash, Pow5Chip as PoseidonChip,
};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter},
    plonk,
};
use pasta_curves::pallas;

/// Computes the protocol Poseidon hash for a fixed number of field inputs.
fn poseidon_hash<const N: usize>(inputs: [pallas::Base; N]) -> pallas::Base {
    poseidon::Hash::<_, poseidon::P128Pow5T3, ConstantLength<N>, 3, 2>::init().hash(inputs)
}

/// Computes `Poseidon(a, b)` with P128Pow5T3, width 3, rate 2.
///
/// Used for Poseidon Merkle path computation and tests. This is the same hash
/// function used by `vote_commitment_tree::MerkleHashVote::combine`.
pub(crate) fn poseidon_hash_2(a: pallas::Base, b: pallas::Base) -> pallas::Base {
    poseidon_hash([a, b])
}

/// Computes `Poseidon(a, b, c)` with P128Pow5T3, width 3, rate 2.
pub(crate) fn poseidon_hash_3(a: pallas::Base, b: pallas::Base, c: pallas::Base) -> pallas::Base {
    poseidon_hash([a, b, c])
}

/// Synthesizes the protocol Poseidon hash for a fixed number of field inputs.
pub(crate) fn poseidon_hash_in_circuit<const N: usize>(
    chip: PoseidonChip<pallas::Base, 3, 2>,
    mut layouter: impl Layouter<pallas::Base>,
    label: &str,
    inputs: [AssignedCell<pallas::Base, pallas::Base>; N],
) -> Result<AssignedCell<pallas::Base, pallas::Base>, plonk::Error> {
    let hasher =
        PoseidonHash::<pallas::Base, _, poseidon::P128Pow5T3, ConstantLength<N>, 3, 2>::init(
            chip,
            layouter.namespace(|| format!("{label} Poseidon init")),
        )?;
    hasher.hash(
        layouter.namespace(|| format!("{label} Poseidon hash")),
        inputs,
    )
}
