//! Inactive current licensed-member membership plus registered spend control.
//! Native code must authenticate the CURRENT root, original member consent and
//! unique immutable member/control registration. This does not prove that a
//! different origin FVK belongs to the same member: an explicitly trusted
//! appointed reviewer must attest that provenance over the composed claim.
use super::poseidon_merkle::MerkleSwapGate;
use super::*;
type F = pallas::Base;
pub const LICENSED_K: u32 = 12;
pub const PUBLIC_INPUTS: usize = 6;
const LEAF_TAG: u64 = 0x5541494e4c494301;
const EMPTY_TAG: u64 = 0x5541494e4c494302;
const NODE_TAG: u64 = 0x5541494e4c494400;
pub fn member_limbs(member: [u8; 32]) -> [F; 2] {
    [
        F::from_u128(u128::from_le_bytes(member[..16].try_into().unwrap())),
        F::from_u128(u128::from_le_bytes(member[16..].try_into().unwrap())),
    ]
}
pub fn leaf(member: [F; 2], control: F, active: bool) -> F {
    let identity = hash::poseidon_hash_3(member[0], member[1], F::from(active as u64));
    hash::poseidon_hash_3(F::from(LEAF_TAG), control, identity)
}
pub fn empty_leaf() -> F {
    hash::poseidon_hash_3(F::from(EMPTY_TAG), F::zero(), F::zero())
}
pub fn node(level: usize, left: F, right: F) -> F {
    assert!(level < 32);
    hash::poseidon_hash_3(F::from(NODE_TAG + level as u64), left, right)
}
pub fn root(mut leaf: F, position: u32, path: [F; 32]) -> F {
    for (i, sibling) in path.into_iter().enumerate() {
        leaf = if (position >> i) & 1 == 0 {
            node(i, leaf, sibling)
        } else {
            node(i, sibling, leaf)
        }
    }
    leaf
}
#[derive(Clone, Debug)]
pub struct LicensedConfig {
    base: Config,
    swap: MerkleSwapGate,
}
impl LicensedConfig {
    fn configure(meta: &mut plonk::ConstraintSystem<F>) -> Self {
        let base = Config::configure(meta);
        let swap = MerkleSwapGate::configure(meta, base.advices[..5].try_into().unwrap());
        Self { base, swap }
    }
    /// Reuse the SAME registered commitment cell returned by assign_control in a
    /// composed claim. Independent matching host-side commitments do not suffice.
    pub(crate) fn assign_membership(
        &self,
        control: &AssignedCell<F, F>,
        member: Value<[F; 2]>,
        position: Value<u32>,
        path: Value<[F; 32]>,
        l: &mut impl Layouter<F>,
    ) -> Result<AssignedCell<F, F>, plonk::Error> {
        let c = &self.base;
        let m0 = assign_free_advice(
            l.namespace(|| "original member key limb0"),
            c.advices[0],
            member.map(|m| m[0]),
        )?;
        let m1 = assign_free_advice(
            l.namespace(|| "original member key limb1"),
            c.advices[0],
            member.map(|m| m[1]),
        )?;
        let active = l.assign_region(
            || "current active licence",
            |mut r| r.assign_advice_from_constant(|| "active only", c.advices[0], 0, F::one()),
        )?;
        let identity = poseidon_hash_in_circuit(
            c.poseidon_chip(),
            l.namespace(|| "licensed original member"),
            "identity",
            [m0, m1, active],
        )?;
        let tag = l.assign_region(
            || "licence leaf domain",
            |mut r| r.assign_advice_from_constant(|| "v1 leaf", c.advices[0], 0, F::from(LEAF_TAG)),
        )?;
        let mut current = poseidon_hash_in_circuit(
            c.poseidon_chip(),
            l.namespace(|| "licensed registered control"),
            "leaf",
            [tag, control.clone(), identity],
        )?;
        for i in 0..32 {
            let bit = assign_free_advice(
                l.namespace(|| format!("licence path bit{i}")),
                c.advices[0],
                position.map(|p| F::from(((p >> i) & 1) as u64)),
            )?;
            let sibling = assign_free_advice(
                l.namespace(|| format!("licence sibling{i}")),
                c.advices[0],
                path.map(|p| p[i]),
            )?;
            let (left, right) = l.assign_region(
                || format!("licence ordering{i}"),
                |mut r| self.swap.assign(&mut r, 0, &bit, &current, &sibling),
            )?;
            let tag = l.assign_region(
                || format!("licence node domain{i}"),
                |mut r| {
                    r.assign_advice_from_constant(
                        || "v1 level",
                        c.advices[0],
                        0,
                        F::from(NODE_TAG + i as u64),
                    )
                },
            )?;
            current = poseidon_hash_in_circuit(
                c.poseidon_chip(),
                l.namespace(|| format!("licence parent{i}")),
                "parent",
                [tag, left, right],
            )?;
        }
        Ok(current)
    }
}
#[derive(Clone, Debug, Default)]
pub struct LicensedCircuit {
    nk: Value<NullifierDerivingKey>,
    ak: Value<SpendValidatingKey>,
    alpha: Value<pallas::Scalar>,
    control_blind: Value<F>,
    member: Value<[F; 2]>,
    position: Value<u32>,
    path: Value<[F; 32]>,
    context: Value<[F; 2]>,
    effects_blind: Value<F>,
}
impl plonk::Circuit<F> for LicensedCircuit {
    type Config = LicensedConfig;
    type FloorPlanner = floor_planner::V1;
    fn without_witnesses(&self) -> Self {
        Self::default()
    }
    fn configure(meta: &mut plonk::ConstraintSystem<F>) -> Self::Config {
        LicensedConfig::configure(meta)
    }
    fn synthesize(&self, c: LicensedConfig, mut l: impl Layouter<F>) -> Result<(), plonk::Error> {
        SinsemillaChip::load(c.base.sinsemilla_config_1.clone(), &mut l)?;
        let control = registration::assign_control(
            &c.base,
            self.nk,
            self.ak.clone(),
            self.alpha,
            self.control_blind,
            [1, 2],
            &mut l,
        )?;
        let root = c.assign_membership(
            &control.commitment,
            self.member,
            self.position,
            self.path,
            &mut l,
        )?;
        l.constrain_instance(root.cell(), c.base.primary, 0)?;
        let a = assign_free_advice(
            l.namespace(|| "claim context0"),
            c.base.advices[0],
            self.context.map(|v| v[0]),
        )?;
        let b = assign_free_advice(
            l.namespace(|| "claim context1"),
            c.base.advices[0],
            self.context.map(|v| v[1]),
        )?;
        l.constrain_instance(a.cell(), c.base.primary, 3)?;
        l.constrain_instance(b.cell(), c.base.primary, 4)?;
        let ctx = poseidon_hash_in_circuit(
            c.base.poseidon_chip(),
            l.namespace(|| "registered claim context"),
            "context",
            [root, a, b],
        )?;
        let blind = assign_free_advice(
            l.namespace(|| "registered effects blind"),
            c.base.advices[0],
            self.effects_blind,
        )?;
        let effect = poseidon_hash_in_circuit(
            c.base.poseidon_chip(),
            l.namespace(|| "registered claim effects"),
            "effects",
            [ctx, control.commitment, blind],
        )?;
        l.constrain_instance(effect.cell(), c.base.primary, 5)?;
        Ok(())
    }
}
impl LicensedCircuit {
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        fvk: &FullViewingKey,
        alpha: pallas::Scalar,
        control_blind: F,
        member: [u8; 32],
        position: u32,
        path: [F; 32],
        context: [F; 2],
        effects_blind: F,
    ) -> Result<(Self, Vec<F>), &'static str> {
        let (_, registration) =
            registration::RegistrationCircuit::from_parts(fvk, alpha, control_blind, context)?;
        let control = registration[0];
        let member = member_limbs(member);
        let root = root(leaf(member, control, true), position, path);
        let effects = hash::poseidon_hash_3(
            hash::poseidon_hash_3(root, context[0], context[1]),
            control,
            effects_blind,
        );
        Ok((
            Self {
                nk: Value::known(*fvk.nk()),
                ak: Value::known(SpendValidatingKey::from(fvk.clone())),
                alpha: Value::known(alpha),
                control_blind: Value::known(control_blind),
                member: Value::known(member),
                position: Value::known(position),
                path: Value::known(path),
                context: Value::known(context),
                effects_blind: Value::known(effects_blind),
            },
            vec![
                root,
                registration[3],
                registration[4],
                context[0],
                context[1],
                effects,
            ],
        ))
    }
}
#[cfg(test)]
mod tests;
