use super::*;
use halo2_proofs::{
    circuit::SimpleFloorPlanner,
    dev::MockProver,
    plonk::{Circuit, ConstraintSystem, Instance},
};
#[derive(Clone, Default)]
struct KeyCircuit {
    nf: Value<F>,
    bytes: Value<[u8; 32]>,
}
#[derive(Clone, Debug)]
struct KeyConfig {
    bits: CanonicalBitsConfig,
    instance: Column<Instance>,
    advice: Column<Advice>,
}
impl Circuit<F> for KeyCircuit {
    type Config = KeyConfig;
    type FloorPlanner = SimpleFloorPlanner;
    fn without_witnesses(&self) -> Self {
        Self::default()
    }
    fn configure(m: &mut ConstraintSystem<F>) -> KeyConfig {
        let f = m.fixed_column();
        m.enable_constant(f);
        let advice = m.advice_column();
        m.enable_equality(advice);
        let instance = m.instance_column();
        m.enable_equality(instance);
        KeyConfig {
            bits: CanonicalBitsConfig::configure(m),
            instance,
            advice,
        }
    }
    fn synthesize(&self, c: KeyConfig, mut l: impl Layouter<F>) -> Result<(), plonk::Error> {
        let nf = orchard::circuit::gadget::assign_free_advice(
            l.namespace(|| "derived nf"),
            c.advice,
            self.nf,
        )?;
        l.constrain_instance(nf.cell(), c.instance, 0)?;
        c.bits
            .assign(l.namespace(|| "canonical key bits"), &nf, self.bytes)?;
        Ok(())
    }
}
#[test]
fn actual_canonical_bits_cover_zero_max_and_reject_field_aliases() {
    for nf in [F::zero(), F::one(), -F::one()] {
        let c = KeyCircuit {
            nf: Value::known(nf),
            bytes: Value::known(nf.to_repr()),
        };
        MockProver::run(10, &c, vec![vec![nf]])
            .unwrap()
            .assert_satisfied();
    }
    let mut modulus = (-F::one()).to_repr();
    let mut carry = 1u16;
    for b in &mut modulus {
        let n = *b as u16 + carry;
        *b = n as u8;
        carry = n >> 8;
    }
    for (nf, bytes) in [
        (F::zero(), modulus),
        (F::zero(), [255; 32]),
        (F::one(), F::zero().to_repr()),
    ] {
        let c = KeyCircuit {
            nf: Value::known(nf),
            bytes: Value::known(bytes),
        };
        assert!(MockProver::run(10, &c, vec![vec![nf]])
            .unwrap()
            .verify()
            .is_err());
    }
}
#[derive(Clone, Default)]
struct PathCircuit {
    nf: Value<F>,
    bytes: Value<[u8; 32]>,
    path: Value<[F; 256]>,
}
#[derive(Clone, Debug)]
struct PathConfig {
    sparse: SparsePathConfig,
    instance: Column<Instance>,
    advice: Column<Advice>,
}
impl Circuit<F> for PathCircuit {
    type Config = PathConfig;
    type FloorPlanner = SimpleFloorPlanner;
    fn without_witnesses(&self) -> Self {
        Self::default()
    }
    fn configure(m: &mut ConstraintSystem<F>) -> PathConfig {
        use halo2_gadgets::poseidon::primitives::P128Pow5T3;
        let constant = m.fixed_column();
        m.enable_constant(constant);
        let advices: [Column<Advice>; 5] = core::array::from_fn(|_| m.advice_column());
        for c in advices {
            m.enable_equality(c);
        }
        let instance = m.instance_column();
        m.enable_equality(instance);
        let poseidon = (0..4)
            .map(|_| {
                let a: [Column<Advice>; 4] = core::array::from_fn(|_| m.advice_column());
                let f: [Column<Fixed>; 6] = core::array::from_fn(|_| m.fixed_column());
                Pow5Chip::configure::<P128Pow5T3>(
                    m,
                    a[..3].try_into().unwrap(),
                    a[3],
                    f[..3].try_into().unwrap(),
                    f[3..].try_into().unwrap(),
                )
            })
            .collect();
        PathConfig {
            sparse: SparsePathConfig::configure(m, advices, poseidon),
            instance,
            advice: advices[0],
        }
    }
    fn synthesize(&self, c: PathConfig, mut l: impl Layouter<F>) -> Result<(), plonk::Error> {
        let nf = orchard::circuit::gadget::assign_free_advice(
            l.namespace(|| "derived nf"),
            c.advice,
            self.nf,
        )?;
        l.constrain_instance(nf.cell(), c.instance, 0)?;
        let root = c.sparse.assign_absence(
            l.namespace(|| "full sparse absence"),
            &nf,
            self.bytes,
            self.path,
        )?;
        l.constrain_instance(root.cell(), c.instance, 1)?;
        Ok(())
    }
}
#[test]
fn full_depth_constraints_reject_occupied_changed_root_and_changed_path() {
    let mut tree = smt::SparseTree::new();
    let nf = -F::one();
    let key = nf.to_repr();
    tree.insert(F::zero().to_repr()).unwrap();
    let path: [F; 256] = tree.path(key).unwrap().try_into().unwrap();
    let c = PathCircuit {
        nf: Value::known(nf),
        bytes: Value::known(key),
        path: Value::known(path),
    };
    MockProver::run(13, &c, vec![vec![nf, tree.root()]])
        .unwrap()
        .assert_satisfied();
    assert!(
        MockProver::run(13, &c, vec![vec![nf, tree.root() + F::one()]])
            .unwrap()
            .verify()
            .is_err()
    );
    let mut altered = c.clone();
    altered.path = Value::known({
        let mut p = path;
        p[255] += F::one();
        p
    });
    assert!(MockProver::run(13, &altered, vec![vec![nf, tree.root()]])
        .unwrap()
        .verify()
        .is_err());
    tree.insert(key).unwrap();
    let mut occupied = c;
    occupied.path = Value::known(tree.path(key).unwrap().try_into().unwrap());
    assert!(MockProver::run(13, &occupied, vec![vec![nf, tree.root()]])
        .unwrap()
        .verify()
        .is_err());
}
