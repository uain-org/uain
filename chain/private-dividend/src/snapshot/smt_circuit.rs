//! Canonical field-key decomposition and full-depth Poseidon exclusion gadget.
//! Versioned domains match smt.rs; callers must constrain the returned root.
use super::{hash::poseidon_hash_in_circuit, poseidon_merkle::MerkleSwapGate, smt};
use halo2_gadgets::{
    poseidon::{Pow5Chip, Pow5Config},
    utilities::bool_check,
};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, Value},
    plonk::{self, Advice, Column, Constraints, Fixed, Selector},
    poly::Rotation,
};
use pasta_curves::{group::ff::PrimeField, pallas};
type F = pallas::Base;
#[derive(Clone, Debug)]
pub struct CanonicalBitsConfig {
    cols: [Column<Advice>; 4],
    fixed: [Column<Fixed>; 2],
    select: Selector,
}
impl CanonicalBitsConfig {
    pub fn configure(meta: &mut plonk::ConstraintSystem<F>) -> Self {
        let cols = core::array::from_fn(|_| meta.advice_column());
        for c in cols {
            meta.enable_equality(c);
        }
        let fixed = core::array::from_fn(|_| meta.fixed_column());
        let select = meta.selector();
        meta.create_gate("canonical full-field sparse key bits", |m| {
            let q = m.query_selector(select);
            let bit = m.query_advice(cols[0], Rotation::cur());
            let borrow = m.query_advice(cols[1], Rotation::cur());
            let diff = m.query_advice(cols[2], Rotation::cur());
            let acc = m.query_advice(cols[3], Rotation::cur());
            let borrow_next = m.query_advice(cols[1], Rotation::next());
            let acc_next = m.query_advice(cols[3], Rotation::next());
            let max = m.query_fixed(fixed[0]);
            let weight = m.query_fixed(fixed[1]);
            Constraints::with_selector(
                q,
                [
                    bool_check(bit.clone()),
                    bool_check(borrow.clone()),
                    bool_check(diff.clone()),
                    max - bit.clone() - borrow + borrow_next * F::from(2) - diff,
                    acc_next - acc - bit * weight,
                ],
            )
        });
        Self {
            cols,
            fixed,
            select,
        }
    }
    /// Witness bytes are constrained <=p-1 AND recomposed into the SAME derived NF.
    /// A modular field recomposition alone would accept aliases such as NF+p.
    pub fn assign(
        &self,
        mut l: impl Layouter<F>,
        nf: &AssignedCell<F, F>,
        bytes: Value<[u8; 32]>,
    ) -> Result<Vec<AssignedCell<F, F>>, plonk::Error> {
        let max = (-F::one()).to_repr();
        l.assign_region(
            || "canonical sparse key",
            |mut r| {
                let mut bits = Vec::with_capacity(256);
                let mut borrow = Value::known(0u64);
                let mut acc = Value::known(F::zero());
                let mut weight = F::one();
                for i in 0..256 {
                    self.select.enable(&mut r, i)?;
                    let maxbit = ((max[i / 8] >> (i % 8)) & 1) as u64;
                    let bit = bytes.map(|b| ((b[i / 8] >> (i % 8)) & 1) as u64);
                    r.assign_fixed(
                        || "modulus minus one bit",
                        self.fixed[0],
                        i,
                        || Value::known(F::from(maxbit)),
                    )?;
                    r.assign_fixed(|| "bit weight", self.fixed[1], i, || Value::known(weight))?;
                    bits.push(r.assign_advice(|| "bit", self.cols[0], i, || bit.map(F::from))?);
                    let bcell =
                        r.assign_advice(|| "borrow", self.cols[1], i, || borrow.map(F::from))?;
                    let acell = r.assign_advice(|| "accumulator", self.cols[3], i, || acc)?;
                    if i == 0 {
                        r.constrain_constant(bcell.cell(), F::zero())?;
                        r.constrain_constant(acell.cell(), F::zero())?;
                    }
                    let delta = bit
                        .zip(borrow)
                        .map(|(bit, b)| maxbit as i64 - bit as i64 - b as i64);
                    r.assign_advice(
                        || "difference bit",
                        self.cols[2],
                        i,
                        || delta.map(|n| F::from(n.rem_euclid(2) as u64)),
                    )?;
                    borrow = delta.map(|n| if n < 0 { 1 } else { 0 });
                    acc = acc.zip(bit).map(|(a, b)| a + F::from(b) * weight);
                    weight = weight.double();
                }
                let final_borrow =
                    r.assign_advice(|| "final borrow", self.cols[1], 256, || borrow.map(F::from))?;
                r.constrain_constant(final_borrow.cell(), F::zero())?;
                let final_acc =
                    r.assign_advice(|| "final accumulator", self.cols[3], 256, || acc)?;
                r.constrain_equal(final_acc.cell(), nf.cell())?;
                Ok(bits)
            },
        )
    }
}
#[derive(Clone, Debug)]
pub struct SparsePathConfig {
    bits: CanonicalBitsConfig,
    swap: MerkleSwapGate,
    advice: Column<Advice>,
    poseidon: Vec<Pow5Config<F, 3, 2>>,
}
impl SparsePathConfig {
    pub(crate) fn configure(
        meta: &mut plonk::ConstraintSystem<F>,
        swap_advices: [Column<Advice>; 5],
        poseidon: Vec<Pow5Config<F, 3, 2>>,
    ) -> Self {
        assert!(!poseidon.is_empty());
        Self {
            bits: CanonicalBitsConfig::configure(meta),
            swap: MerkleSwapGate::configure(meta, swap_advices),
            advice: swap_advices[0],
            poseidon,
        }
    }
    pub fn assign_absence(
        &self,
        mut l: impl Layouter<F>,
        nf: &AssignedCell<F, F>,
        bytes: Value<[u8; 32]>,
        path: Value<[F; 256]>,
    ) -> Result<AssignedCell<F, F>, plonk::Error> {
        let bits = self.bits.assign(l.namespace(|| "sparse key"), nf, bytes)?;
        let mut cur = l.assign_region(
            || "sparse empty leaf",
            |mut r| r.assign_advice_from_constant(|| "empty", self.advice, 0, smt::empty_leaf()),
        )?;
        for i in 0..256 {
            let sibling = orchard::circuit::gadget::assign_free_advice(
                l.namespace(|| format!("sparse sibling {i}")),
                self.advice,
                path.map(|p| p[i]),
            )?;
            let (left, right) = l.assign_region(
                || format!("sparse order {i}"),
                |mut r| self.swap.assign(&mut r, 0, &bits[i], &cur, &sibling),
            )?;
            let tag = l.assign_region(
                || format!("sparse domain {i}"),
                |mut r| {
                    r.assign_advice_from_constant(
                        || "node domain",
                        self.advice,
                        0,
                        smt::node_domain(i),
                    )
                },
            )?;
            cur = poseidon_hash_in_circuit(
                Pow5Chip::construct(self.poseidon[i % self.poseidon.len()].clone()),
                l.namespace(|| format!("sparse parent {i}")),
                "versioned sparse parent",
                [tag, left, right],
            )?;
        }
        Ok(cur)
    }
}

#[cfg(test)]
mod tests;
