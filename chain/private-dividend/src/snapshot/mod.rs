// Adapted from Valar Group voting-circuits e19c2a4d065b7b369ccd6ccdedcd489e9c0d079c.
// Copyright (c) 2025 Valar Group. MIT license: ../../THIRD-PARTY-LICENSE-MIT.
// UAIN adaptations are experimental and inactive; the pinned upstream audit
// scope does not certify this port, its current dependencies, or this protocol.
//! INACTIVE composed one-note snapshot and exact-ratio prototype.
//! Inputs roots/context/P/M MUST come from authenticated native state. This
//! circuit does not authenticate state, verify a licence, consume a claim, or
//! transfer funds. The external spend signature remains mandatory.
pub mod authorization;
mod hash;
pub mod imt;
mod imt_circuit;
pub mod licensed;
pub mod owner_carry;
mod poseidon_merkle;
pub mod registration;
mod spend_authority;
#[cfg(test)]
mod tests;
use crate::{RatioChip, RatioConfig, RatioWitness};
use hash::poseidon_hash_in_circuit;
use imt::IMT_DEPTH;
use imt_circuit::{synthesize_imt_non_membership, ImtNonMembershipConfig};
const MERKLE_LANES: usize = 4;
const SINSEMILLA_ADVICE_COLUMNS: usize = 5;
pub const K: u32 = 12;
use std::vec::Vec;

use halo2_gadgets::{
    ecc::{
        chip::{EccChip, EccConfig},
        CircuitVersion, NonIdentityPoint, Point, ScalarFixed, ScalarVar,
    },
    poseidon::{
        primitives::{self as poseidon},
        Pow5Chip as PoseidonChip, Pow5Config as PoseidonConfig,
    },
    sinsemilla::{
        chip::{SinsemillaChip, SinsemillaConfig},
        merkle::{
            chip::{MerkleChip, MerkleConfig},
            MerklePath as GadgetMerklePath,
        },
    },
    utilities::lookup_range_check::{LookupRangeCheck, LookupRangeCheckConfig},
};
use halo2_proofs::{
    circuit::{floor_planner, AssignedCell, Layouter, Value},
    plonk::{self, Advice, Column, Constraints, Instance as InstanceColumn, Selector},
    poly::Rotation,
};
use orchard::{
    circuit::{
        commit_ivk::{CommitIvkChip, CommitIvkConfig},
        gadget::{
            add_chip::{AddChip, AddConfig},
            assign_free_advice, derive_nullifier, note_commit,
        },
        note_commit::{NoteCommitChip, NoteCommitConfig},
    },
    constants::{
        OrchardCommitDomains, OrchardFixedBases, OrchardHashDomains, MERKLE_DEPTH_ORCHARD,
    },
    keys::{CommitIvkRandomness, FullViewingKey, NullifierDerivingKey, Scope, SpendValidatingKey},
    note::{Note, NoteVersion},
    spec::NonIdentityPallasPoint,
    tree::MerkleHashOrchard,
    value::NoteValue,
};
use pasta_curves::group::{Curve, GroupEncoding};
use pasta_curves::{
    arithmetic::{Coordinates, CurveAffine},
    group::ff::PrimeField,
    pallas,
};

#[derive(Clone, Debug)]
pub struct Config {
    // The instance column (public inputs)
    primary: Column<InstanceColumn>,
    // 10 advice columns for private witness data.
    // This is the scratch space where the prover places intermediate values during computation.
    // Various chips use these columns
    // Poseidon: [5..9]
    // ECC: uses all 10
    // AddChip: uses [6..9]
    advices: [Column<Advice>; 10],
    // Configuration for the AddChip which constrains a + b = c over field elements.
    // Used inside DeriveNullifier to combine intermediate values.
    add_config: AddConfig,
    // Configuration for the ECCChip which provides elliptic curve operations
    // (point addition, scalar multiplication) on the Pallas curve with Orchard's fixes bases.
    ecc_config: EccConfig<OrchardFixedBases>,
    // Poseidon chip config. Used in the DeriveNullifier.
    poseidon_config: PoseidonConfig<pallas::Base, 3, 2>,
    // Sinsemilla config 1 — used for loading the lookup table that
    // LookupRangeCheckConfig (and thus EccChip) depends on, for CommitIvk,
    // and for the signed note's NoteCommit. Uses advices[..5].
    sinsemilla_config_1:
        SinsemillaConfig<OrchardHashDomains, OrchardCommitDomains, OrchardFixedBases>,
    // Configuration to handle decomposition and canonicity checking for CommitIvk.
    commit_ivk_config: CommitIvkConfig,
    // Configuration for decomposition and canonicity checking for the signed note's NoteCommit.
    note_commit_config: NoteCommitConfig,
    // Each path distributes its levels across the four Merkle chips, balancing
    // work across their independent column lanes.
    merkle_configs:
        [MerkleConfig<OrchardHashDomains, OrchardCommitDomains, OrchardFixedBases>; MERKLE_LANES],
    // Merkle advice lanes.
    imt_poseidon_configs: [PoseidonConfig<pallas::Base, 3, 2>; MERKLE_LANES],
    // Per-note custom gate selector (conditions 10, 13).
    // imt_root = nf_imt_root.
    q_per_note: Selector,
    // IMT non-membership gates (condition 13): conditional swap + interval check.
    imt_config: ImtNonMembershipConfig,
    q_bind_value: Selector,
    sparse: Option<smt_circuit::SparsePathConfig>,
}

impl Config {
    fn add_chip(&self) -> AddChip {
        AddChip::construct(self.add_config.clone())
    }

    fn ecc_chip(&self) -> EccChip<OrchardFixedBases> {
        EccChip::construct(self.ecc_config.clone(), CircuitVersion::AnchoredBase)
    }

    // Operating over the Pallas base field, with a width of 3 (state size) and rate of 2
    // 3 comes from the P128Pow5T3 construction used throughout Orchard (i.e. 3 is width)
    // Rate of 2 means that two elements are absorbed per permutation, so the hash completes
    // in fewer rounds than rate 1, roughly halving the number of Poseidon permutations.
    fn poseidon_chip(&self) -> PoseidonChip<pallas::Base, 3, 2> {
        PoseidonChip::construct(self.poseidon_config.clone())
    }

    fn commit_ivk_chip(&self) -> CommitIvkChip {
        CommitIvkChip::construct(self.commit_ivk_config.clone())
    }

    fn sinsemilla_chip_1(
        &self,
    ) -> SinsemillaChip<OrchardHashDomains, OrchardCommitDomains, OrchardFixedBases> {
        SinsemillaChip::construct(self.sinsemilla_config_1.clone())
    }

    fn note_commit_chip(&self) -> NoteCommitChip {
        NoteCommitChip::construct(self.note_commit_config.clone())
    }

    fn merkle_chips(
        &self,
    ) -> [MerkleChip<OrchardHashDomains, OrchardCommitDomains, OrchardFixedBases>; MERKLE_LANES]
    {
        core::array::from_fn(|lane| MerkleChip::construct(self.merkle_configs[lane].clone()))
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct NoteSlotWitness {
    pub(super) g_d: Value<NonIdentityPallasPoint>,
    pub(super) pk_d: Value<NonIdentityPallasPoint>,
    pub(super) v: Value<NoteValue>,
    pub(super) rho: Value<pallas::Base>,
    pub(super) psi: Value<pallas::Base>,
    pub(super) rcm: Value<pallas::Scalar>,
    pub(super) cm: Value<pallas::Affine>,
    pub(super) path: Value<[MerkleHashOrchard; MERKLE_DEPTH_ORCHARD]>,
    pub(super) pos: Value<u32>,
    pub(super) imt_nf_bounds: Value<[pallas::Base; 3]>,
    pub(super) imt_leaf_pos: Value<u32>,
    pub(super) imt_path: Value<[pallas::Base; IMT_DEPTH]>,
}

#[derive(Clone, Debug, Default)]
pub struct SnapshotCircuit {
    nk: Value<NullifierDerivingKey>,
    ak: Value<SpendValidatingKey>,
    alpha: Value<pallas::Scalar>,
    rivk: Value<CommitIvkRandomness>,
    note: NoteSlotWitness,
    ratio: Option<RatioWitness>,
    // Public fields: NCT_H, IMT_H, receipt context's two 128-bit limbs,
    // randomized rk x/y, claim nullifier, effects commitment.
    // Recipient digest, v, q, remainder and blind stay private.
    public: Value<[pallas::Base; 8]>,
    recipient: Value<[pallas::Base; 2]>,
    effect_blind: Value<pallas::Base>,
}
#[derive(Clone, Debug)]
pub struct SnapshotConfig {
    snapshot: Config,
    ratio: RatioConfig,
}
impl plonk::Circuit<pallas::Base> for SnapshotCircuit {
    type Config = SnapshotConfig;
    type FloorPlanner = floor_planner::V1;
    fn without_witnesses(&self) -> Self {
        Self::default()
    }
    fn configure(meta: &mut plonk::ConstraintSystem<pallas::Base>) -> Self::Config {
        let snapshot = Config::configure(meta);
        let ratio = RatioChip::configure_with_instance(meta, snapshot.primary);
        SnapshotConfig { snapshot, ratio }
    }
    fn synthesize(
        &self,
        config: Self::Config,
        l: impl Layouter<pallas::Base>,
    ) -> Result<(), plonk::Error> {
        SnapshotChip::construct(config).assign(self, l).map(|_| ())
    }
}
/// Returned cells belong to the SAME note and arithmetic relation. Future
/// payout circuits must copy these cells rather than supply a second amount.
pub struct SnapshotCells {
    pub owned_value: AssignedCell<pallas::Base, pallas::Base>,
    pub amounts: crate::RatioCells,
    pub claim_nullifier: AssignedCell<pallas::Base, pallas::Base>,
    pub effects_commitment: AssignedCell<pallas::Base, pallas::Base>,
}
pub struct SnapshotChip {
    config: SnapshotConfig,
}
impl SnapshotChip {
    pub fn construct(config: SnapshotConfig) -> Self {
        Self { config }
    }
    pub fn assign(
        &self,
        w: &SnapshotCircuit,
        l: impl Layouter<pallas::Base>,
    ) -> Result<SnapshotCells, plonk::Error> {
        self.assign_inner(w, None, l)
    }
    fn assign_inner(
        &self,
        w: &SnapshotCircuit,
        sparse_path: Option<Value<[pallas::Base; 256]>>,
        mut l: impl Layouter<pallas::Base>,
    ) -> Result<SnapshotCells, plonk::Error> {
        let c = &self.config.snapshot;
        SinsemillaChip::load(c.sinsemilla_config_1.clone(), &mut l)?;
        let e = c.ecc_chip();
        let public: Vec<_> = (0..8)
            .map(|i| {
                let cell = assign_free_advice(
                    l.namespace(|| format!("public {i}")),
                    c.advices[0],
                    w.public.map(|v| v[i]),
                )?;
                l.constrain_instance(cell.cell(), c.primary, i)?;
                Ok(cell)
            })
            .collect::<Result<_, plonk::Error>>()?;
        let ak = NonIdentityPoint::new(
            e.clone(),
            l.namespace(|| "ak"),
            w.ak.as_ref().map(|a| pallas::Point::from(a).to_affine()),
        )?;
        spend_authority::prove_spend_authority(
            e.clone(),
            l.namespace(|| "same owner randomized spend authority"),
            w.alpha,
            &ak.clone().into(),
            c.primary,
            4,
            5,
        )?;
        let nk = assign_free_advice(l.namespace(|| "nk"), c.advices[0], w.nk.map(|n| n.inner()))?;
        let rivk = ScalarFixed::new(e.clone(), l.namespace(|| "rivk"), w.rivk.map(|r| r.inner()))?;
        let ivk = orchard::circuit::commit_ivk::gadgets::commit_ivk(
            c.sinsemilla_chip_1(),
            e.clone(),
            c.commit_ivk_chip(),
            l.namespace(|| "same owner CommitIvk"),
            ak.extract_p().inner().clone(),
            nk.clone(),
            rivk,
        )?
        .inner()
        .clone();
        let tag = l.assign_region(
            || "UAIN domain constant",
            |mut r| {
                r.assign_advice_from_constant(
                    || "UAIN dividend receipt v1",
                    c.advices[0],
                    0,
                    domain_tag(),
                )
            },
        )?;
        let domain = poseidon_hash_in_circuit(
            c.poseidon_chip(),
            l.namespace(|| "receipt domain"),
            "receipt",
            [tag, public[2].clone(), public[3].clone()],
        )?;
        let (_, value, claim_nf) = synthesize_note_slot(
            c,
            &mut l,
            e,
            &ivk,
            &nk,
            &domain,
            &public[0],
            &public[1],
            &w.note,
            sparse_path,
            0,
            6,
        )?;
        let amounts =
            RatioChip::construct(self.config.ratio.clone()).assign(&mut l, w.ratio.as_ref())?;
        l.assign_region(
            || "same owned holding bytes",
            |mut r| {
                c.q_bind_value.enable(&mut r, 0)?;
                value.copy_advice(|| "owned value", &mut r, c.advices[0], 0)?;
                for (i, b) in amounts.holding.iter().enumerate() {
                    b.cell
                        .copy_advice(|| "ratio holding byte", &mut r, c.advices[i + 1], 0)?;
                }
                Ok(())
            },
        )?;
        // Exact pool and full minted denominator are public authenticated inputs.
        for (i, b) in amounts.pool.iter().chain(&amounts.minted).enumerate() {
            l.constrain_instance(b.cell.cell(), c.primary, 8 + i)?;
        }
        // Commit every q byte separately: never compress a 259-bit amount into
        // a single 254-bit field. Fixed-length chaining has distinct domain tags.
        let blind = assign_free_advice(
            l.namespace(|| "effects blind"),
            c.advices[0],
            w.effect_blind,
        )?;
        let recipient: Vec<_> = (0..2)
            .map(|i| {
                assign_free_advice(
                    l.namespace(|| format!("private recipient {i}")),
                    c.advices[0],
                    w.recipient.map(|v| v[i]),
                )
            })
            .collect::<Result<_, _>>()?;
        let mut effect = poseidon_hash_in_circuit(
            c.poseidon_chip(),
            l.namespace(|| "effects owner receipt"),
            "effects",
            [domain, claim_nf.clone(), blind],
        )?;
        effect = poseidon_hash_in_circuit(
            c.poseidon_chip(),
            l.namespace(|| "effects recipient"),
            "recipient",
            [effect, recipient[0].clone(), recipient[1].clone()],
        )?;
        for (i, b) in amounts.quotient.iter().enumerate() {
            effect = poseidon_hash_in_circuit(
                c.poseidon_chip(),
                l.namespace(|| format!("effects q byte {i}")),
                "q",
                [effect, b.cell.clone()],
            )?;
        }
        l.assign_region(
            || "effects binding",
            |mut r| r.constrain_equal(effect.cell(), public[7].cell()),
        )?;
        Ok(SnapshotCells {
            owned_value: value,
            amounts,
            claim_nullifier: claim_nf,
            effects_commitment: effect,
        })
    }
}

impl Config {
    fn configure(meta: &mut plonk::ConstraintSystem<pallas::Base>) -> Self {
        let advices = [
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
        ];

        // Instance column used for public inputs.
        let primary = meta.instance_column();

        // Fixed columns for the Sinsemilla generator lookup table.
        let table_idx = meta.lookup_table_column();
        let lookup = (
            table_idx,
            meta.lookup_table_column(),
            meta.lookup_table_column(),
        );

        // 8 fixed columns shared between ECC (Lagrange interpolation coefficients)
        // and Poseidon (round constants). Different rows hold different data.
        let lagrange_coeffs = [
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
        ];
        let rc_a = lagrange_coeffs[2..5].try_into().unwrap();
        let rc_b = lagrange_coeffs[5..8].try_into().unwrap();

        // Independent lanes shared by all Orchard Merkle paths. Each chip has
        // its own advice and fixed-y column.
        let merkle_advices: [[Column<Advice>; SINSEMILLA_ADVICE_COLUMNS]; MERKLE_LANES] =
            core::array::from_fn(|_| core::array::from_fn(|_| meta.advice_column()));
        let merkle_fixed_y_q: [Column<plonk::Fixed>; MERKLE_LANES] =
            core::array::from_fn(|_| meta.fixed_column());
        let imt_poseidon_round_constants: [[Column<plonk::Fixed>; 6]; MERKLE_LANES] =
            core::array::from_fn(|_| core::array::from_fn(|_| meta.fixed_column()));

        // ── Column properties ────────────────────────────────────────────

        // Enable equality constraints (permutation argument) on all advice columns
        // and the instance column, so any cell can be copy-constrained to any other.
        meta.enable_equality(primary);
        for advice in advices.iter() {
            meta.enable_equality(*advice);
        }

        // Use the first Lagrange coefficient column for loading global constants.
        meta.enable_constant(lagrange_coeffs[0]);

        // ── Custom gates ─────────────────────────────────────────────────

        // Per-note custom gates (conditions 10, 13).
        // q_per_note is a selector that activates these constraints only on rows
        // where note data is assigned. The single owned input note gets one
        // such row; on all other rows the selector is 0 and the gate is inactive.
        let q_per_note = meta.selector();
        meta.create_gate("Per-note checks", |meta| {
            let q_per_note = meta.query_selector(q_per_note);
            let _v = meta.query_advice(advices[0], Rotation::cur());
            let root = meta.query_advice(advices[1], Rotation::cur());
            let anchor = meta.query_advice(advices[2], Rotation::cur());
            let imt_root = meta.query_advice(advices[3], Rotation::cur());
            let nf_imt_root = meta.query_advice(advices[4], Rotation::cur());

            Constraints::with_selector(
                q_per_note,
                [
                    // Cond 10: Merkle root must match the public nc_root for notes
                    // Orchard's standard dummy note mechanism (ZIP §Note Padding).
                    ("root = anchor (no dummy bypass)", root - anchor),
                    // Cond 13: IMT root from non-membership proof must match public
                    // nf_imt_root. Not gated — dummy notes check too.
                    ("imt_root = nf_imt_root", imt_root - nf_imt_root),
                ],
            )
        });

        let q_bind_value = meta.selector();
        meta.create_gate("ratio holding is owned note value", |m| {
            let q = m.query_selector(q_bind_value);
            let value = m.query_advice(advices[0], Rotation::cur());
            let bytes = (0..8)
                .map(|i| {
                    m.query_advice(advices[i + 1], Rotation::cur())
                        * plonk::Expression::Constant(pallas::Base::from(1u64 << (8 * i)))
                })
                .reduce(|a, b| a + b)
                .unwrap();
            vec![q * (value - bytes)]
        });
        // IMT non-membership gates (condition 13): conditional swap + interval check.
        let imt_config = ImtNonMembershipConfig::configure(meta, &advices);

        // ── Chip configurations ──────────────────────────────────────────

        let add_config = AddChip::configure(meta, advices[7], advices[8], advices[6]);

        // Range check configuration using the right-most advice column.
        let range_check = LookupRangeCheckConfig::configure(meta, advices[9], table_idx);

        let ecc_config =
            EccChip::<OrchardFixedBases>::configure(meta, advices, lagrange_coeffs, range_check);

        let poseidon_config = PoseidonChip::configure::<poseidon::P128Pow5T3>(
            meta,
            advices[6..9].try_into().unwrap(),
            advices[5],
            rc_a,
            rc_b,
        );

        // Two shared Sinsemilla chips. NoteCommit internally needs two
        // instances (one per hash), so we can't reuse a single config.
        //
        // Column layout:
        //   Pair 1: main = advices[0..5], witness = advices[6]
        //   Pair 2: main = advices[5..10], witness = advices[7]
        //
        // The pairs intentionally overlap on advices[5..7] to keep the total
        // column count at 10 (matching upstream Orchard). This is safe because
        // each pair's gates are gated by their own selectors, and the two chips
        // are never assigned to the same rows.
        let configure_sinsemilla =
            |meta: &mut plonk::ConstraintSystem<pallas::Base>,
             advice_cols: [Column<Advice>; 5],
             witness_col: Column<Advice>,
             lagrange_col: Column<plonk::Fixed>| {
                SinsemillaChip::configure(
                    meta,
                    advice_cols,
                    witness_col,
                    lagrange_col,
                    lookup,
                    range_check,
                    false,
                )
            };

        let sinsemilla_config_1 = configure_sinsemilla(
            meta,
            advices[..5].try_into().unwrap(),
            advices[6],
            lagrange_coeffs[0],
        );
        let merkle_configs = core::array::from_fn(|lane| {
            let sinsemilla = configure_sinsemilla(
                meta,
                merkle_advices[lane],
                merkle_advices[lane][2],
                merkle_fixed_y_q[lane],
            );
            MerkleChip::configure(meta, sinsemilla)
        });

        let imt_poseidon_configs = core::array::from_fn(|lane| {
            PoseidonChip::configure::<poseidon::P128Pow5T3>(
                meta,
                merkle_advices[lane][..3].try_into().unwrap(),
                merkle_advices[lane][3],
                imt_poseidon_round_constants[lane][..3].try_into().unwrap(),
                imt_poseidon_round_constants[lane][3..].try_into().unwrap(),
            )
        });

        // Configuration to handle decomposition and canonicity checking for CommitIvk.
        let commit_ivk_config = CommitIvkChip::configure(meta, advices);

        // Configuration for decomposition and canonicity checking for the signed note's NoteCommit.
        let note_commit_config =
            NoteCommitChip::configure(meta, advices, sinsemilla_config_1.clone());
        Config {
            primary,
            advices,
            add_config,
            ecc_config,
            poseidon_config,
            sinsemilla_config_1,
            commit_ivk_config,
            note_commit_config,
            merkle_configs,
            imt_poseidon_configs,
            q_per_note,
            imt_config,
            q_bind_value,
            sparse: None,
        }
    }
}
pub fn domain_tag() -> pallas::Base {
    pallas::Base::from_u128(u128::from_le_bytes(*b"UAINdividend:v1!"))
}
fn synthesize_note_slot(
    config: &Config,
    layouter: &mut impl Layouter<pallas::Base>,
    ecc_chip: EccChip<OrchardFixedBases>,
    ivk_cell: &AssignedCell<pallas::Base, pallas::Base>,
    nk_cell: &AssignedCell<pallas::Base, pallas::Base>,
    dom_cell: &AssignedCell<pallas::Base, pallas::Base>,
    nc_root_cell: &AssignedCell<pallas::Base, pallas::Base>,
    nf_imt_root_cell: &AssignedCell<pallas::Base, pallas::Base>,
    note: &NoteSlotWitness,
    sparse_path: Option<Value<[pallas::Base; 256]>>,
    slot: usize,
    claim_nullifier_offset: usize,
) -> Result<
    (
        AssignedCell<pallas::Base, pallas::Base>,
        AssignedCell<pallas::Base, pallas::Base>,
        AssignedCell<pallas::Base, pallas::Base>,
    ),
    plonk::Error,
> {
    let s = slot; // shorthand for format strings

    // ---------------------------------------------------------------
    // Condition 9: Note commitment integrity.
    // ---------------------------------------------------------------

    // Proves the prover knows the note's plaintext (address, value, rho, psi)
    // and that it hashes to the claimed commitment. This is the foundation —
    // all other per-note conditions build on these witnessed values.

    // Witness the note's address components as curve points.
    let g_d = NonIdentityPoint::new(
        ecc_chip.clone(),
        layouter.namespace(|| format!("note {s} witness g_d")),
        note.g_d.as_ref().map(|gd| gd.to_affine()),
    )?;

    let pk_d = NonIdentityPoint::new(
        ecc_chip.clone(),
        layouter.namespace(|| format!("note {s} witness pk_d")),
        note.pk_d.as_ref().map(|pk| pk.to_affine()),
    )?;

    // Witness the note's value, rho, and psi as field elements.
    let v = assign_free_advice(
        layouter.namespace(|| format!("note {s} witness v")),
        config.advices[0],
        note.v,
    )?;

    let rho = assign_free_advice(
        layouter.namespace(|| format!("note {s} witness rho")),
        config.advices[0],
        note.rho,
    )?;

    let psi = assign_free_advice(
        layouter.namespace(|| format!("note {s} witness psi")),
        config.advices[0],
        note.psi,
    )?;

    // Witness rcm (commitment randomness) as a fixed-base scalar for ECC.
    let rcm = ScalarFixed::new(
        ecc_chip.clone(),
        layouter.namespace(|| format!("note {s} rcm")),
        note.rcm.as_ref().copied(),
    )?;

    // Witness the claimed commitment as a curve point.
    let cm = Point::new(
        ecc_chip.clone(),
        layouter.namespace(|| format!("note {s} witness cm")),
        note.cm.as_ref().copied(),
    )?;

    // `psi` and `rcm` are witnessed rather than derived from `rseed`. This
    // proves that they open `cm`; it does not authenticate a note version.
    let derived_cm = note_commit(
        layouter.namespace(|| format!("note {s} NoteCommit")),
        config.sinsemilla_chip_1(),
        config.ecc_chip(),
        config.note_commit_chip(),
        g_d.inner(),
        pk_d.inner(),
        v.clone(),
        rho.clone(),
        psi.clone(),
        rcm,
    )?;

    derived_cm.constrain_equal(layouter.namespace(|| format!("note {s} cm integrity")), &cm)?;

    // cmx = ExtractP(cm) — returned to caller.
    let cmx_cell = cm.extract_p().inner().clone();

    // Constrain it equal to the NoteValue cell used in note_commit.
    let v_base = assign_free_advice(
        layouter.namespace(|| format!("note {s} witness v_base")),
        config.advices[0],
        note.v.map(|val| pallas::Base::from(val.inner())),
    )?;
    layouter.assign_region(
        || format!("note {s} v = v_base"),
        |mut region| region.constrain_equal(v.cell(), v_base.cell()),
    )?;

    // ---------------------------------------------------------------
    // Condition 11: Diversified address integrity (scope-aware).
    // pk_d = [selected_ivk] * g_d
    // ---------------------------------------------------------------

    // Proves this note belongs to the prover's key. External notes use ivk
    // ivk and the address ownership check below rejects.

    // Convert selected_ivk to a scalar for ECC multiplication.
    let ivk_scalar = ScalarVar::from_base(
        ecc_chip.clone(),
        layouter.namespace(|| format!("note {s} selected_ivk to scalar")),
        ivk_cell,
    )?;

    // Compute [selected_ivk] * g_d and check it matches the witnessed pk_d.
    let (derived_pk_d, _ivk) = g_d.mul(
        layouter.namespace(|| format!("note {s} [selected_ivk] g_d")),
        ivk_scalar,
    )?;

    // Constrain: derived_pk_d == pk_d.
    derived_pk_d.constrain_equal(
        layouter.namespace(|| format!("note {s} pk_d equality")),
        &pk_d,
    )?;

    // ---------------------------------------------------------------
    // Condition 12: Private nullifier derivation.
    // real_nf = DeriveNullifier_nk(rho, psi, cm)
    // ---------------------------------------------------------------

    // Derives the note's real mainchain nullifier in-circuit. This is NOT
    // published — it stays private. It's used for two things:
    //   1. IMT non-membership (cond 13): proves the note is unspent

    let real_nf = derive_nullifier(
        layouter.namespace(|| format!("note {s} real_nf = DeriveNullifier")),
        config.poseidon_chip(),
        config.add_chip(),
        ecc_chip.clone(),
        rho.clone(),
        &psi,
        &cm,
        nk_cell.clone(),
    )?;

    // ---------------------------------------------------------------
    // Condition 14: Alternate nullifier integrity.
    // nf_dom = Poseidon(nk, dom, real_nf)
    // ---------------------------------------------------------------

    // ConstantLength<3> Poseidon hash (2 permutations at rate=2) that:
    //   - Is keyed by nk, so it can't be linked to real_nf even when real_nf is
    //     later revealed on mainchain
    //   - Is scoped to this application instance via dom (a public input derived
    //     out-of-circuit from the protocol identifier and receipt_context)
    //
    // track which notes have already been delegated this round.

    // Poseidon(nk, dom, real_nf)
    let claim_nullifier = poseidon_hash_in_circuit(
        config.poseidon_chip(),
        layouter.namespace(|| format!("note {s} claim_nullifier")),
        "Poseidon(nk, dom, real_nf)",
        [nk_cell.clone(), dom_cell.clone(), real_nf.inner().clone()],
    )?;

    let claim_nullifier_cell = claim_nullifier.clone();
    layouter.constrain_instance(
        claim_nullifier.cell(),
        config.primary,
        claim_nullifier_offset,
    )?;

    // ---------------------------------------------------------------
    // Condition 10: Merkle path validity.
    // ---------------------------------------------------------------

    // Proves the note's commitment exists in the mainchain note commitment tree.
    // Computes the Sinsemilla-based Merkle root from the leaf (cmx = ExtractP(cm))
    // and the 32-level authentication path. The q_per_note gate then checks that
    // the computed root equals the public nc_root (for real notes only).

    let root = {
        // Convert the witnessed Merkle path siblings to raw field elements.
        let path = note
            .path
            .map(|typed_path| typed_path.map(|node| node.inner()));
        let merkle_inputs = GadgetMerklePath::construct(
            config.merkle_chips(),
            OrchardHashDomains::MerkleCrh,
            note.pos,
            path,
        );
        // The leaf is the x-coordinate of the note commitment.
        let leaf = cm.extract_p().inner().clone();
        merkle_inputs
            .calculate_root(layouter.namespace(|| format!("note {s} Merkle path")), leaf)?
    };

    // ---------------------------------------------------------------
    // Condition 13: IMT non-membership.
    // ---------------------------------------------------------------

    let imt_root = if let Some(sparse) = &config.sparse {
        sparse.assign_absence(
            layouter.namespace(|| "full-domain historical sparse exclusion"),
            real_nf.inner(),
            real_nf.inner().value().map(|nf| nf.to_repr()),
            sparse_path.ok_or(plonk::Error::Synthesis)?,
        )?
    } else {
        if sparse_path.is_some() {
            return Err(plonk::Error::Synthesis);
        }
        synthesize_imt_non_membership(
            &config.imt_config,
            &config.imt_poseidon_configs,
            &config.ecc_config,
            layouter,
            note.imt_nf_bounds,
            note.imt_leaf_pos,
            note.imt_path,
            real_nf.inner(),
            s,
        )?
    };

    // ---------------------------------------------------------------
    // Custom gate region: conditions 10 + 13.
    // ---------------------------------------------------------------

    // Activates the q_per_note gate, which ties together results from the
    // preceding conditions into a single row of checks:
    //   - Cond 13: IMT root must match public nf_imt_root
    //
    // All five values are copied from earlier regions via copy constraints,
    // so the gate operates on the same cells that the upstream gadgets produced.

    layouter.assign_region(
        || format!("note {s} per-note checks"),
        |mut region| {
            config.q_per_note.enable(&mut region, 0)?;

            v.copy_advice(|| "v", &mut region, config.advices[0], 0)?;
            root.copy_advice(|| "calculated root", &mut region, config.advices[1], 0)?;
            nc_root_cell.copy_advice(|| "nc_root (anchor)", &mut region, config.advices[2], 0)?;
            imt_root.copy_advice(|| "imt_root", &mut region, config.advices[3], 0)?;
            nf_imt_root_cell.copy_advice(|| "nf_imt_root", &mut region, config.advices[4], 0)?;

            Ok(())
        },
    )?;

    // Return the three values needed by global conditions:
    //   cmx_cell   → condition 3 (rho binding hash)
    //   claim_nullifier   → exposed as public input
    Ok((cmx_cell, v_base, claim_nullifier_cell))
}

impl SnapshotCircuit {
    /// Experimental witness constructor. Caller-supplied roots/context/P/M are
    /// NOT trusted by this method; a future verifier MUST pin them to state H.
    /// FVK knowledge alone does not authorize a claim: the matching randomized
    /// SpendAuth signature over the complete statement must also be checked.
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        fvk: &FullViewingKey,
        note: &Note,
        scope: Scope,
        alpha: pallas::Scalar,
        nct_root: pallas::Base,
        path: [MerkleHashOrchard; 32],
        position: u32,
        nf_proof: &imt::ImtProofData,
        ratio: RatioWitness,
        context: [pallas::Base; 2],
        recipient: [pallas::Base; 2],
        blind: pallas::Base,
    ) -> Result<(Self, Vec<pallas::Base>), &'static str> {
        if note.version() != NoteVersion::V2 {
            return Err("prototype supports current V2 notes only");
        }
        let rho = note.rho();
        let psi = note.rseed().psi(&rho);
        let nk = *fvk.nk();
        let ak = SpendValidatingKey::from(fvk.clone());
        let rk = ak.randomize(&alpha);
        let rk_point = pallas::Point::from_bytes(&<[u8; 32]>::from(rk));
        let rk_point = Option::<pallas::Point>::from(rk_point)
            .ok_or("invalid randomized key")?
            .to_affine();
        let coords = Option::<Coordinates<pallas::Affine>>::from(rk_point.coordinates())
            .ok_or("identity randomized key")?;
        let domain = hash::poseidon_hash_3(domain_tag(), context[0], context[1]);
        let claim_nf = hash::poseidon_hash_3(nk.inner(), domain, note.nullifier(fvk).inner());
        let mut effect = hash::poseidon_hash_3(domain, claim_nf, blind);
        effect = hash::poseidon_hash_3(effect, recipient[0], recipient[1]);
        for b in ratio.quotient {
            effect = hash::poseidon_hash_2(effect, pallas::Base::from(b as u64));
        }
        let fields = [
            nct_root,
            nf_proof.root,
            context[0],
            context[1],
            *coords.x(),
            *coords.y(),
            claim_nf,
            effect,
        ];
        let mut public = fields.to_vec();
        public.extend(
            ratio
                .pool
                .iter()
                .chain(&ratio.minted)
                .map(|b| pallas::Base::from(*b as u64)),
        );
        let witness = NoteSlotWitness {
            g_d: Value::known(note.recipient().g_d()),
            pk_d: Value::known(note.recipient().pk_d().inner()),
            v: Value::known(note.value()),
            rho: Value::known(rho.into_inner()),
            psi: Value::known(psi),
            rcm: Value::known(note.rseed().rcm_v2(&rho).inner()),
            cm: Value::known(note.commitment().inner().to_affine()),
            path: Value::known(path),
            pos: Value::known(position),
            imt_nf_bounds: Value::known(nf_proof.nf_bounds),
            imt_leaf_pos: Value::known(nf_proof.leaf_pos),
            imt_path: Value::known(nf_proof.path),
        };
        Ok((
            Self {
                nk: Value::known(nk),
                ak: Value::known(ak),
                alpha: Value::known(alpha),
                rivk: Value::known(fvk.rivk(scope)),
                note: witness,
                ratio: Some(ratio),
                public: Value::known(fields),
                recipient: Value::known(recipient),
                effect_blind: Value::known(blind),
            },
            public,
        ))
    }
}

pub mod smt;

pub mod smt_circuit;

/// Full-domain variant. Unlike the experimental IMT circuit, this accepts
/// absent NF=0 and NF=p-1. The native verifier must pin THIS circuit's VK.
#[derive(Clone, Default)]
pub struct FullSnapshotCircuit {
    witness: SnapshotCircuit,
    sparse_path: Value<[pallas::Base; 256]>,
}
pub const FULL_SNAPSHOT_K: u32 = 13;
impl plonk::Circuit<pallas::Base> for FullSnapshotCircuit {
    type Config = SnapshotConfig;
    type FloorPlanner = floor_planner::V1;
    fn without_witnesses(&self) -> Self {
        Self::default()
    }
    fn configure(meta: &mut plonk::ConstraintSystem<pallas::Base>) -> Self::Config {
        let mut snapshot = Config::configure(meta);
        snapshot.sparse = Some(smt_circuit::SparsePathConfig::configure(
            meta,
            snapshot.advices[..5].try_into().unwrap(),
            snapshot.imt_poseidon_configs.to_vec(),
        ));
        let ratio = RatioChip::configure_with_instance(meta, snapshot.primary);
        SnapshotConfig { snapshot, ratio }
    }
    fn synthesize(
        &self,
        config: Self::Config,
        l: impl Layouter<pallas::Base>,
    ) -> Result<(), plonk::Error> {
        SnapshotChip::construct(config)
            .assign_inner(&self.witness, Some(self.sparse_path), l)
            .map(|_| ())
    }
}
impl FullSnapshotCircuit {
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        fvk: &FullViewingKey,
        note: &Note,
        scope: Scope,
        alpha: pallas::Scalar,
        nct_root: pallas::Base,
        path: [MerkleHashOrchard; 32],
        position: u32,
        spent_root: pallas::Base,
        spent_path: [pallas::Base; 256],
        ratio: RatioWitness,
        context: [pallas::Base; 2],
        recipient: [pallas::Base; 2],
        blind: pallas::Base,
    ) -> Result<(Self, Vec<pallas::Base>), &'static str> {
        // Reuse only witness/effect construction. This placeholder is never
        // synthesized by the full-domain circuit; no IMT assumption is used.
        let unused_imt = imt::ImtProofData {
            root: spent_root,
            nf_bounds: [pallas::Base::zero(); 3],
            leaf_pos: 0,
            path: [pallas::Base::zero(); IMT_DEPTH],
        };
        let (witness, public) = SnapshotCircuit::from_parts(
            fvk,
            note,
            scope,
            alpha,
            nct_root,
            path,
            position,
            &unused_imt,
            ratio,
            context,
            recipient,
            blind,
        )?;
        Ok((
            Self {
                witness,
                sparse_path: Value::known(spent_path),
            },
            public,
        ))
    }
}
