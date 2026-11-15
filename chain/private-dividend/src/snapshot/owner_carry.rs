//! Inactive receipt-bound carry/output gadget. The standalone circuit below is
//! diagnostic: its control/key/root are witnesses or public assertions, NOT
//! authenticated ownership, licence, historical entitlement or native state.
//! Full composition MUST pass the same registered ControlCells, receipt-domain
//! cell, authenticated root and CarryCells; native code must atomically consume
//! the selected nullifier and historical origin and append the proved outputs.
use super::poseidon_merkle::MerkleSwapGate;
use super::*;
use crate::carry::{CarryCells, CarryChip, CarryWitness};
use crate::ByteCell;
type F = pallas::Base;
pub const CARRY_CONTROL_K: u32 = 13;
pub const PUBLIC_INPUTS: usize = 48;
const CARRY_TAG: u64 = 0x5541494e43415201;
const LEAF_TAG: u64 = 0x5541494e43415202;
const EMPTY_TAG: u64 = 0x5541494e43415203;
const INIT_TAG: u64 = 0x5541494e43415204;
const SPEND_TAG: u64 = 0x5541494e43415205;
const ASSET_TAG: u64 = 0x5541494e43415206;
const NODE_TAG: u64 = 0x5541494e43415300;
fn h(a: F, b: F, c: F) -> F {
    hash::poseidon_hash_3(a, b, c)
}
fn packed(bytes: &[u8]) -> F {
    assert!(bytes.len() <= 16);
    bytes
        .iter()
        .rev()
        .fold(F::zero(), |a, b| a * F::from(256) + F::from(*b as u64))
}
pub fn carry_commitment(control: F, domain: F, remainder: &[u8; 9], blind: F) -> F {
    h(
        F::from(CARRY_TAG),
        control,
        h(domain, packed(remainder), blind),
    )
}
pub fn carry_leaf(commitment: F) -> F {
    h(F::from(LEAF_TAG), commitment, F::one())
}
pub fn empty_leaf() -> F {
    h(F::from(EMPTY_TAG), F::zero(), F::zero())
}
pub fn node(level: usize, left: F, right: F) -> F {
    assert!(level < 32);
    h(F::from(NODE_TAG + level as u64), left, right)
}
pub fn root(mut leaf: F, position: u32, path: [F; 32]) -> F {
    for (i, sibling) in path.into_iter().enumerate() {
        leaf = if (position >> i) & 1 == 0 {
            node(i, leaf, sibling)
        } else {
            node(i, sibling, leaf)
        };
    }
    leaf
}
pub fn initialization_nullifier(nk: F, control: F, domain: F) -> F {
    h(F::from(INIT_TAG), nk, h(control, domain, F::zero()))
}
pub fn spend_nullifier(nk: F, previous: F) -> F {
    h(F::from(SPEND_TAG), nk, previous)
}
/// Three limbs preserve all 264 witness bits; the ranged arithmetic separately
/// caps q at 78 decimal digits. Reducing the whole amount into F would alias.
pub fn asset_commitment(control: F, domain: F, amount: &[u8; 33], blind: F) -> F {
    let owner_asset = h(F::from(ASSET_TAG), control, domain);
    h(
        h(owner_asset, packed(&amount[..16]), packed(&amount[16..32])),
        F::from(amount[32] as u64),
        blind,
    )
}
pub fn effects(root: F, domain: F, nf: F, carry: F, asset: F) -> F {
    h(h(root, domain, nf), carry, asset)
}
#[derive(Clone, Debug)]
pub struct CarryControlConfig {
    base: Config,
    ratio: RatioConfig,
    pack: Selector,
    branch: Selector,
    swap: MerkleSwapGate,
}
#[derive(Clone, Debug)]
pub struct CarryControlWitness {
    pub initialize: Value<F>,
    pub position: Value<u32>,
    pub path: Value<[F; 32]>,
    pub previous_blind: Value<F>,
    pub next_blind: Value<F>,
    pub asset_blind: Value<F>,
}
pub struct CarryControlCells {
    pub nullifier: AssignedCell<F, F>,
    pub next: AssignedCell<F, F>,
    pub asset: AssignedCell<F, F>,
    pub effects: AssignedCell<F, F>,
}
impl CarryControlConfig {
    /// Compose over the parent configuration; never create an independently
    /// assigned control/key or amount merely equal in host-side code.
    pub(crate) fn configure_with_base(
        meta: &mut plonk::ConstraintSystem<F>,
        base: Config,
        ratio: RatioConfig,
    ) -> Self {
        let pack = meta.selector();
        meta.create_gate("carry exact byte packing", |m| {
            let q = m.query_selector(pack);
            let a = m.query_advice(base.advices[0], Rotation::cur());
            let byte = m.query_advice(base.advices[1], Rotation::cur());
            let out = m.query_advice(base.advices[2], Rotation::cur());
            vec![q * (a * plonk::Expression::Constant(F::from(256)) + byte - out)]
        });
        let branch = meta.selector();
        meta.create_gate("carry single initialization or authenticated spend", |m| {
            let q = m.query_selector(branch);
            let v: Vec<_> = base.advices[..7]
                .iter()
                .map(|c| m.query_advice(*c, Rotation::cur()))
                .collect();
            let one = plonk::Expression::Constant(F::one());
            vec![
                q.clone() * v[0].clone() * (v[0].clone() - one.clone()),
                q.clone() * v[0].clone() * v[1].clone(),
                q.clone() * (one.clone() - v[0].clone()) * (v[2].clone() - v[3].clone()),
                q * (v[6].clone()
                    - v[0].clone() * v[4].clone()
                    - (one - v[0].clone()) * v[5].clone()),
            ]
        });
        let swap = MerkleSwapGate::configure(meta, base.advices[..5].try_into().unwrap());
        Self {
            base,
            ratio,
            pack,
            branch,
            swap,
        }
    }
    fn constant(
        &self,
        l: &mut impl Layouter<F>,
        value: F,
    ) -> Result<AssignedCell<F, F>, plonk::Error> {
        l.assign_region(
            || "carry constant",
            |mut r| r.assign_advice_from_constant(|| "constant", self.base.advices[0], 0, value),
        )
    }
    fn free(
        &self,
        l: &mut impl Layouter<F>,
        value: Value<F>,
    ) -> Result<AssignedCell<F, F>, plonk::Error> {
        assign_free_advice(
            l.namespace(|| "carry private witness"),
            self.base.advices[0],
            value,
        )
    }
    fn hash(
        &self,
        l: &mut impl Layouter<F>,
        v: [AssignedCell<F, F>; 3],
    ) -> Result<AssignedCell<F, F>, plonk::Error> {
        poseidon_hash_in_circuit(
            self.base.poseidon_chip(),
            l.namespace(|| "carry domain hash"),
            "carry",
            v,
        )
    }
    fn tagged(
        &self,
        l: &mut impl Layouter<F>,
        tag: u64,
        b: AssignedCell<F, F>,
        c: AssignedCell<F, F>,
    ) -> Result<AssignedCell<F, F>, plonk::Error> {
        let a = self.constant(l, F::from(tag))?;
        self.hash(l, [a, b, c])
    }
    /// COPY each previously range-checked byte. At most 16 bytes per limb, so
    /// field packing is injective and cannot wrap modulo the Pallas modulus.
    fn pack(
        &self,
        l: &mut impl Layouter<F>,
        bytes: &[ByteCell],
    ) -> Result<AssignedCell<F, F>, plonk::Error> {
        assert!(bytes.len() <= 16);
        let mut a = self.constant(l, F::zero())?;
        for b in bytes.iter().rev() {
            a = l.assign_region(
                || "pack existing ranged bytes",
                |mut r| {
                    self.pack.enable(&mut r, 0)?;
                    a.copy_advice(|| "previous accumulator", &mut r, self.base.advices[0], 0)?;
                    b.cell
                        .copy_advice(|| "ranged byte", &mut r, self.base.advices[1], 0)?;
                    r.assign_advice(
                        || "exact limb",
                        self.base.advices[2],
                        0,
                        || {
                            a.value().copied() * Value::known(F::from(256))
                                + b.cell.value().copied()
                        },
                    )
                },
            )?;
        }
        Ok(a)
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn assign(
        &self,
        l: &mut impl Layouter<F>,
        control: &AssignedCell<F, F>,
        nk: &AssignedCell<F, F>,
        domain: &AssignedCell<F, F>,
        authenticated_root: &AssignedCell<F, F>,
        amount: &CarryCells,
        w: CarryControlWitness,
    ) -> Result<CarryControlCells, plonk::Error> {
        let previous = self.pack(l, &amount.previous)?;
        let next = self.pack(l, &amount.next)?;
        let previous_blind = self.free(l, w.previous_blind)?;
        let next_blind = self.free(l, w.next_blind)?;
        let prior_hidden = self.hash(l, [domain.clone(), previous.clone(), previous_blind])?;
        let prior = self.tagged(l, CARRY_TAG, control.clone(), prior_hidden)?;
        let next_hidden = self.hash(l, [domain.clone(), next, next_blind])?;
        let next = self.tagged(l, CARRY_TAG, control.clone(), next_hidden)?;
        let one = self.constant(l, F::one())?;
        let mut computed = self.tagged(l, LEAF_TAG, prior.clone(), one)?;
        for i in 0..32 {
            let bit = self.free(l, w.position.map(|p| F::from(((p >> i) & 1) as u64)))?;
            let sibling = self.free(l, w.path.map(|p| p[i]))?;
            let (left, right) = l.assign_region(
                || "carry path ordering",
                |mut r| self.swap.assign(&mut r, 0, &bit, &computed, &sibling),
            )?;
            computed = self.tagged(l, NODE_TAG + i as u64, left, right)?;
        }
        let zero = self.constant(l, F::zero())?;
        let init_context = self.hash(l, [control.clone(), domain.clone(), zero])?;
        let init_nf = self.tagged(l, INIT_TAG, nk.clone(), init_context)?;
        let spend_nf = self.tagged(l, SPEND_TAG, nk.clone(), prior)?;
        let initialize = self.free(l, w.initialize)?;
        let nullifier = l.assign_region(
            || "carry branch and nullifier",
            |mut r| {
                self.branch.enable(&mut r, 0)?;
                for (i, cell) in [
                    &initialize,
                    &previous,
                    &computed,
                    authenticated_root,
                    &init_nf,
                    &spend_nf,
                ]
                .into_iter()
                .enumerate()
                {
                    cell.copy_advice(
                        || "constrained branch input",
                        &mut r,
                        self.base.advices[i],
                        0,
                    )?;
                }
                r.assign_advice(
                    || "selected private nullifier",
                    self.base.advices[6],
                    0,
                    || {
                        initialize.value().copied() * init_nf.value().copied()
                            + (Value::known(F::one()) - initialize.value().copied())
                                * spend_nf.value().copied()
                    },
                )
            },
        )?;
        let q0 = self.pack(l, &amount.quotient[..16])?;
        let q1 = self.pack(l, &amount.quotient[16..32])?;
        let q2 = self.pack(l, &amount.quotient[32..])?;
        let asset_seed = self.tagged(l, ASSET_TAG, control.clone(), domain.clone())?;
        let asset_amount = self.hash(l, [asset_seed, q0, q1])?;
        let asset_blind = self.free(l, w.asset_blind)?;
        let asset = self.hash(l, [asset_amount, q2, asset_blind])?;
        let ctx = self.hash(
            l,
            [
                authenticated_root.clone(),
                domain.clone(),
                nullifier.clone(),
            ],
        )?;
        let effects = self.hash(l, [ctx, next.clone(), asset.clone()])?;
        Ok(CarryControlCells {
            nullifier,
            next,
            asset,
            effects,
        })
    }
}
/// Diagnostic harness only. It exposes P/M and output commitments but does NOT
/// prove the supplied control belongs to an owner or root to the native chain.
#[derive(Clone, Debug, Default)]
pub struct CarryControlCircuit {
    amounts: Option<CarryWitness>,
    control: Value<F>,
    nk: Value<F>,
    domain: Value<F>,
    init: Value<F>,
    position: Value<u32>,
    path: Value<[F; 32]>,
    previous_blind: Value<F>,
    next_blind: Value<F>,
    asset_blind: Value<F>,
    public: Value<[F; PUBLIC_INPUTS]>,
}
impl plonk::Circuit<F> for CarryControlCircuit {
    type Config = CarryControlConfig;
    type FloorPlanner = floor_planner::V1;
    fn without_witnesses(&self) -> Self {
        Self::default()
    }
    fn configure(m: &mut plonk::ConstraintSystem<F>) -> Self::Config {
        let base = Config::configure(m);
        let ratio = RatioChip::configure_with_instance(m, base.primary);
        CarryControlConfig::configure_with_base(m, base, ratio)
    }
    fn synthesize(&self, c: Self::Config, mut l: impl Layouter<F>) -> Result<(), plonk::Error> {
        SinsemillaChip::load(c.base.sinsemilla_config_1.clone(), &mut l)?;
        let amount = CarryChip::construct(c.ratio.clone()).assign(&mut l, self.amounts.as_ref())?;
        let control = c.free(&mut l, self.control)?;
        let nk = c.free(&mut l, self.nk)?;
        let domain = c.free(&mut l, self.domain)?;
        l.constrain_instance(domain.cell(), c.base.primary, 1)?;
        let root = c.free(&mut l, self.public.map(|p| p[0]))?;
        l.constrain_instance(root.cell(), c.base.primary, 0)?;
        let out = c.assign(
            &mut l,
            &control,
            &nk,
            &domain,
            &root,
            &amount,
            CarryControlWitness {
                initialize: self.init,
                position: self.position,
                path: self.path,
                previous_blind: self.previous_blind,
                next_blind: self.next_blind,
                asset_blind: self.asset_blind,
            },
        )?;
        for (i, v) in [out.nullifier, out.next, out.asset, out.effects]
            .iter()
            .enumerate()
        {
            l.constrain_instance(v.cell(), c.base.primary, 2 + i)?;
        }
        for (i, b) in amount.pool.iter().chain(&amount.minted).enumerate() {
            l.constrain_instance(b.cell.cell(), c.base.primary, 6 + i)?;
        }
        Ok(())
    }
}
impl CarryControlCircuit {
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        amounts: CarryWitness,
        control: F,
        nk: F,
        domain: F,
        init: bool,
        position: u32,
        path: [F; 32],
        previous_blind: F,
        next_blind: F,
        asset_blind: F,
    ) -> Result<(Self, Vec<F>), &'static str> {
        let prior = carry_commitment(control, domain, &amounts.previous, previous_blind);
        let root = root(carry_leaf(prior), position, path);
        let nf = if init {
            initialization_nullifier(nk, control, domain)
        } else {
            spend_nullifier(nk, prior)
        };
        let next = carry_commitment(control, domain, &amounts.next, next_blind);
        let asset = asset_commitment(control, domain, &amounts.quotient, asset_blind);
        let mut public = vec![
            root,
            domain,
            nf,
            next,
            asset,
            effects(root, domain, nf, next, asset),
        ];
        public.extend(
            amounts
                .pool
                .iter()
                .chain(&amounts.minted)
                .map(|b| F::from(*b as u64)),
        );
        let array: [F; PUBLIC_INPUTS] = public
            .clone()
            .try_into()
            .map_err(|_| "wrong carry public size")?;
        Ok((
            Self {
                amounts: Some(amounts),
                control: Value::known(control),
                nk: Value::known(nk),
                domain: Value::known(domain),
                init: Value::known(F::from(init as u64)),
                position: Value::known(position),
                path: Value::known(path),
                previous_blind: Value::known(previous_blind),
                next_blind: Value::known(next_blind),
                asset_blind: Value::known(asset_blind),
                public: Value::known(array),
            },
            public,
        ))
    }
}
#[cfg(test)]
mod tests;
