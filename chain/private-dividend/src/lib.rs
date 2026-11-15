//! Inactive exact integer arithmetic component, NOT a dividend entitlement proof.
//! The default circuit is diagnostic arithmetic only. The default-off
//! snapshot-prototype feature is an experimental composition, not a native claim route.
//! See docs/chain/confidential-dividend.md before composing this chip into a circuit.
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, Region, SimpleFloorPlanner, Value},
    plonk::{
        Advice, Circuit, Column, ConstraintSystem, Error, Expression, Instance, Selector,
        TableColumn,
    },
    poly::Rotation,
};
use pasta_curves::pallas;
type F = pallas::Base;

/// Production claim acceptance remains unavailable regardless of arithmetic proofs.
pub const CLAIMS_ENABLED: bool = false;
pub const SUPPLY_CAP: u128 = 108_000_000_000_000_000_000;
/// Native economy bounded canonical atomic units: at most 78 decimal digits.
pub const ATOMIC_CAP_LE: [u8; 33] = [
    255, 255, 255, 255, 255, 255, 255, 255, 255, 63, 58, 94, 80, 210, 244, 169, 114, 51, 132, 199,
    38, 147, 86, 227, 182, 122, 204, 223, 66, 241, 219, 162, 8,
];

/// Fixed-width LITTLE-ENDIAN unsigned bytes. These are witness values, not claims.
#[derive(Clone, Debug)]
pub struct RatioWitness {
    pub pool: [u8; 33],
    pub holding: [u8; 8],
    pub minted: [u8; 9],
    pub quotient: [u8; 33],
    pub remainder: [u8; 9],
}
impl RatioWitness {
    /// Diagnostic circuit exposes all bytes. It provides NO party privacy.
    pub fn public_inputs(&self) -> Vec<F> {
        self.pool
            .iter()
            .chain(&self.holding)
            .chain(&self.minted)
            .chain(&self.quotient)
            .chain(&self.remainder)
            .map(|b| F::from(*b as u64))
            .collect()
    }
}
#[derive(Clone, Debug)]
pub struct RatioConfig {
    cols: [Column<Advice>; 6],
    range: Selector,
    mul: Selector,
    add: Selector,
    table: TableColumn,
    instance: Column<Instance>,
}
#[derive(Clone, Debug)]
pub struct ByteCell {
    pub cell: AssignedCell<F, F>,
    value: Value<u64>,
}
/// A future composition must COPY these same cells to authenticated public
/// snapshot inputs and the constrained note/entitlement commitment gadgets.
#[derive(Clone, Debug)]
pub struct RatioCells {
    pub pool: Vec<ByteCell>,
    pub holding: Vec<ByteCell>,
    pub minted: Vec<ByteCell>,
    pub quotient: Vec<ByteCell>,
    pub remainder: Vec<ByteCell>,
}
impl RatioCells {
    fn all(&self) -> impl Iterator<Item = &ByteCell> {
        self.pool
            .iter()
            .chain(&self.holding)
            .chain(&self.minted)
            .chain(&self.quotient)
            .chain(&self.remainder)
    }
}
pub struct RatioChip {
    config: RatioConfig,
}
impl RatioChip {
    pub fn configure(meta: &mut ConstraintSystem<F>) -> RatioConfig {
        let instance = meta.instance_column();
        Self::configure_with_instance(meta, instance)
    }
    /// Compose into a parent circuit's instance column; avoids an extra unused
    /// public-input column while preserving the standalone diagnostic layout.
    pub fn configure_with_instance(
        meta: &mut ConstraintSystem<F>,
        instance: Column<Instance>,
    ) -> RatioConfig {
        let cols = std::array::from_fn(|_| meta.advice_column());
        for c in cols {
            meta.enable_equality(c);
        }
        let fixed = meta.fixed_column();
        meta.enable_constant(fixed);
        meta.enable_equality(instance);
        let table = meta.lookup_table_column();
        let range = meta.complex_selector();
        let mul = meta.selector();
        let add = meta.selector();
        for c in cols {
            meta.lookup(|m| {
                vec![(
                    m.query_selector(range) * m.query_advice(c, Rotation::cur()),
                    table,
                )]
            });
        }
        meta.create_gate("byte multiply accumulate", |m| {
            let q = m.query_selector(mul);
            let x: Vec<_> = cols
                .iter()
                .map(|c| m.query_advice(*c, Rotation::cur()))
                .collect();
            vec![
                q * (x[0].clone() * x[1].clone() + x[2].clone() + x[3].clone()
                    - x[4].clone()
                    - Expression::Constant(F::from(256)) * x[5].clone()),
            ]
        });
        meta.create_gate("byte add with boolean carry", |m| {
            let q = m.query_selector(add);
            let x: Vec<_> = cols
                .iter()
                .map(|c| m.query_advice(*c, Rotation::cur()))
                .collect();
            let one = Expression::Constant(F::from(1));
            vec![
                q.clone()
                    * (x[0].clone() + x[1].clone() + x[2].clone()
                        - x[4].clone()
                        - Expression::Constant(F::from(256)) * x[5].clone()),
                q.clone() * x[2].clone() * (x[2].clone() - one.clone()),
                q * x[5].clone() * (x[5].clone() - one),
            ]
        });
        RatioConfig {
            cols,
            range,
            mul,
            add,
            table,
            instance,
        }
    }
    pub fn construct(config: RatioConfig) -> Self {
        Self { config }
    }
    pub fn assign(
        &self,
        layouter: &mut impl Layouter<F>,
        w: Option<&RatioWitness>,
    ) -> Result<RatioCells, Error> {
        layouter.assign_table(
            || "unsigned byte table",
            |mut t| {
                for i in 0..256 {
                    t.assign_cell(
                        || "byte",
                        self.config.table,
                        i,
                        || Value::known(F::from(i as u64)),
                    )?;
                }
                Ok(())
            },
        )?;
        layouter.assign_region(
            || "exact dividend arithmetic",
            |mut region| {
                let mut s = Arithmetic {
                    config: &self.config,
                    region: &mut region,
                    row: 0,
                };
                let zero = s.constant(0)?;
                let one = s.constant(1)?;
                let pool = s.load(w.map(|v| v.pool.as_slice()), 33)?;
                let holding = s.load(w.map(|v| v.holding.as_slice()), 8)?;
                let minted = s.load(w.map(|v| v.minted.as_slice()), 9)?;
                let quotient = s.load(w.map(|v| v.quotient.as_slice()), 33)?;
                let remainder = s.load(w.map(|v| v.remainder.as_slice()), 9)?;
                let atomic_cap = s.load(Some(&ATOMIC_CAP_LE), 33)?;
                for (b, v) in atomic_cap.iter().zip(ATOMIC_CAP_LE) {
                    s.region
                        .constrain_constant(b.cell.cell(), F::from(v as u64))?;
                }
                let gap = s.difference(&atomic_cap, &pool, 0)?;
                let check = s.add_bytes(&gap, &pool, &zero, &zero)?;
                s.equal_bytes(&check, &atomic_cap, &zero)?;
                let left = s.multiply(&pool, &holding, &zero)?;
                let right = s.multiply(&quotient, &minted, &zero)?;
                let sum = s.add_bytes(&right, &remainder, &zero, &zero)?;
                for (i, b) in sum.iter().enumerate() {
                    s.equal(b, left.get(i).unwrap_or(&zero))?;
                }
                // Strict r<M, positive v, v<=M, M<=full minted cap. The differences
                // are range-checked bytes; wrapped negative witnesses cannot pass.
                let gap = s.difference(&minted, &remainder, 1)?;
                let check = s.add_bytes(&gap, &remainder, &one, &zero)?;
                s.equal_bytes(&check, &minted, &zero)?;
                let gap = s.difference(&minted, &holding, 0)?;
                let check = s.add_bytes(&gap, &holding, &zero, &zero)?;
                s.equal_bytes(&check, &minted, &zero)?;
                let cap_raw = SUPPLY_CAP.to_le_bytes();
                let cap = s.load(Some(&cap_raw[..9]), 9)?;
                // Bind cap bytes to constants, not merely a host-assigned witness.
                for (b, v) in cap.iter().zip(&cap_raw) {
                    s.region
                        .constrain_constant(b.cell.cell(), F::from(*v as u64))?;
                }
                let gap = s.difference(&cap, &minted, 0)?;
                let check = s.add_bytes(&gap, &minted, &zero, &zero)?;
                s.equal_bytes(&check, &cap, &zero)?;
                let gap = s.difference(&holding, &[], 1)?;
                let check = s.add_bytes(&gap, &[], &one, &zero)?;
                s.equal_bytes(&check, &holding, &zero)?;
                Ok(RatioCells {
                    pool,
                    holding,
                    minted,
                    quotient,
                    remainder,
                })
            },
        )
    }
}
struct Arithmetic<'a, 'r> {
    config: &'a RatioConfig,
    region: &'a mut Region<'r, F>,
    row: usize,
}
impl Arithmetic<'_, '_> {
    fn row(
        &mut self,
        values: [Value<u64>; 6],
        sources: [Option<&ByteCell>; 6],
    ) -> Result<Vec<ByteCell>, Error> {
        self.config.range.enable(self.region, self.row)?;
        let mut out = Vec::new();
        for i in 0..6 {
            let cell = self.region.assign_advice(
                || "byte",
                self.config.cols[i],
                self.row,
                || values[i].map(F::from),
            )?;
            if let Some(src) = sources[i] {
                self.region.constrain_equal(cell.cell(), src.cell.cell())?;
            }
            out.push(ByteCell {
                cell,
                value: values[i],
            });
        }
        self.row += 1;
        Ok(out)
    }
    fn constant(&mut self, n: u64) -> Result<ByteCell, Error> {
        let b = self
            .row(
                [
                    Value::known(n),
                    Value::known(0),
                    Value::known(0),
                    Value::known(0),
                    Value::known(0),
                    Value::known(0),
                ],
                [None; 6],
            )?
            .remove(0);
        self.region.constrain_constant(b.cell.cell(), F::from(n))?;
        Ok(b)
    }
    fn load(&mut self, bytes: Option<&[u8]>, len: usize) -> Result<Vec<ByteCell>, Error> {
        self.load_values(
            (0..len)
                .map(|i| {
                    bytes
                        .map(|b| Value::known(b[i] as u64))
                        .unwrap_or(Value::unknown())
                })
                .collect(),
        )
    }
    fn load_values(&mut self, values: Vec<Value<u64>>) -> Result<Vec<ByteCell>, Error> {
        values
            .into_iter()
            .map(|v| {
                Ok(self
                    .row(
                        [
                            v,
                            Value::known(0),
                            Value::known(0),
                            Value::known(0),
                            Value::known(0),
                            Value::known(0),
                        ],
                        [None; 6],
                    )?
                    .remove(0))
            })
            .collect()
    }
    fn equal(&mut self, a: &ByteCell, b: &ByteCell) -> Result<(), Error> {
        self.region.constrain_equal(a.cell.cell(), b.cell.cell())
    }
    fn equal_bytes(
        &mut self,
        a: &[ByteCell],
        b: &[ByteCell],
        zero: &ByteCell,
    ) -> Result<(), Error> {
        for i in 0..a.len().max(b.len()) {
            self.equal(a.get(i).unwrap_or(zero), b.get(i).unwrap_or(zero))?;
        }
        Ok(())
    }
    fn multiply(
        &mut self,
        a: &[ByteCell],
        b: &[ByteCell],
        zero: &ByteCell,
    ) -> Result<Vec<ByteCell>, Error> {
        let mut out = vec![zero.clone(); a.len() + b.len()];
        for (i, ai) in a.iter().enumerate() {
            let mut carry = zero.clone();
            for (j, bj) in b.iter().enumerate() {
                let old = &out[i + j];
                let t = ai
                    .value
                    .zip(bj.value)
                    .zip(old.value)
                    .zip(carry.value)
                    .map(|(((a, b), c), d)| a * b + c + d);
                self.config.mul.enable(self.region, self.row)?;
                let row = self.row(
                    [
                        ai.value,
                        bj.value,
                        old.value,
                        carry.value,
                        t.map(|x| x % 256),
                        t.map(|x| x / 256),
                    ],
                    [Some(ai), Some(bj), Some(old), Some(&carry), None, None],
                )?;
                out[i + j] = row[4].clone();
                carry = row[5].clone();
            }
            out[i + b.len()] = carry;
        }
        Ok(out)
    }
    fn add_bytes(
        &mut self,
        a: &[ByteCell],
        b: &[ByteCell],
        initial: &ByteCell,
        zero: &ByteCell,
    ) -> Result<Vec<ByteCell>, Error> {
        let mut carry = initial.clone();
        let mut out = Vec::new();
        for i in 0..a.len().max(b.len()) {
            let ai = a.get(i).unwrap_or(zero);
            let bi = b.get(i).unwrap_or(zero);
            let t = ai
                .value
                .zip(bi.value)
                .zip(carry.value)
                .map(|((a, b), c)| a + b + c);
            self.config.add.enable(self.region, self.row)?;
            let row = self.row(
                [
                    ai.value,
                    bi.value,
                    carry.value,
                    Value::known(0),
                    t.map(|x| x % 256),
                    t.map(|x| x / 256),
                ],
                [Some(ai), Some(bi), Some(&carry), None, None, None],
            )?;
            out.push(row[4].clone());
            carry = row[5].clone();
        }
        self.equal(&carry, zero)?;
        Ok(out)
    }
    fn difference(
        &mut self,
        a: &[ByteCell],
        b: &[ByteCell],
        initial: u64,
    ) -> Result<Vec<ByteCell>, Error> {
        let mut borrow = Value::known(initial as i64);
        let mut out = Vec::new();
        for i in 0..a.len().max(b.len()) {
            let av = a.get(i).map(|x| x.value).unwrap_or(Value::known(0));
            let bv = b.get(i).map(|x| x.value).unwrap_or(Value::known(0));
            let t = av
                .zip(bv)
                .zip(borrow)
                .map(|((a, b), c)| a as i64 - b as i64 - c);
            out.push(t.map(|x| x.rem_euclid(256) as u64));
            borrow = t.map(|x| if x < 0 { 1 } else { 0 });
        }
        self.load_values(out)
    }
}
/// Constraint-test harness only: exposes note value and payout, has no proof
/// serialization or acceptance entry point. Compose RatioChip for future privacy.
#[derive(Clone, Default)]
pub struct RatioCircuit {
    witness: Option<RatioWitness>,
}
impl RatioCircuit {
    pub fn from_witness(w: RatioWitness) -> Self {
        Self { witness: Some(w) }
    }
}
impl Circuit<F> for RatioCircuit {
    type Config = RatioConfig;
    type FloorPlanner = SimpleFloorPlanner;
    fn without_witnesses(&self) -> Self {
        Self::default()
    }
    fn configure(meta: &mut ConstraintSystem<F>) -> RatioConfig {
        RatioChip::configure(meta)
    }
    fn synthesize(&self, config: RatioConfig, mut layouter: impl Layouter<F>) -> Result<(), Error> {
        let cells =
            RatioChip::construct(config.clone()).assign(&mut layouter, self.witness.as_ref())?;
        for (i, b) in cells.all().enumerate() {
            layouter.constrain_instance(b.cell.cell(), config.instance, i)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod hostile_rows {
    use super::*;
    use halo2_proofs::dev::MockProver;
    #[derive(Clone)]
    struct RawRow {
        values: [F; 6],
        add: bool,
    }
    impl Circuit<F> for RawRow {
        type Config = RatioConfig;
        type FloorPlanner = SimpleFloorPlanner;
        fn without_witnesses(&self) -> Self {
            self.clone()
        }
        fn configure(m: &mut ConstraintSystem<F>) -> RatioConfig {
            RatioChip::configure(m)
        }
        fn synthesize(&self, c: RatioConfig, mut l: impl Layouter<F>) -> Result<(), Error> {
            l.assign_table(
                || "bytes",
                |mut t| {
                    for i in 0..256 {
                        t.assign_cell(|| "b", c.table, i, || Value::known(F::from(i as u64)))?;
                    }
                    Ok(())
                },
            )?;
            l.assign_region(
                || "malicious raw advice",
                |mut r| {
                    c.range.enable(&mut r, 0)?;
                    if self.add {
                        c.add.enable(&mut r, 0)?;
                    } else {
                        c.mul.enable(&mut r, 0)?;
                    }
                    for (i, v) in self.values.iter().enumerate() {
                        r.assign_advice(|| "adversarial byte", c.cols[i], 0, || Value::known(*v))?;
                    }
                    Ok(())
                },
            )
        }
    }
    fn ok(v: [u64; 6], add: bool) -> bool {
        raw_ok(v.map(F::from), add)
    }
    fn raw_ok(values: [F; 6], add: bool) -> bool {
        MockProver::run(9, &RawRow { values, add }, vec![vec![]])
            .unwrap()
            .verify()
            .is_ok()
    }
    #[test]
    fn range_checks_apply_to_every_multiply_byte_and_carry() {
        assert!(ok([255, 255, 255, 255, 255, 255], false));
        assert!(!ok([256, 0, 0, 0, 0, 0], false));
        assert!(!ok([0, 256, 0, 0, 0, 0], false));
        assert!(!ok([0, 0, 256, 0, 0, 1], false));
        assert!(!ok([0, 0, 0, 256, 0, 1], false));
        assert!(!ok([0, 0, 0, 0, 256, 0], false));
        assert!(!ok([0, 0, 0, 0, 0, 256], false));
        assert!(!ok([2, 3, 0, 0, 7, 0], false));
        assert!(!raw_ok(
            [
                -F::from(1),
                F::from(0),
                F::from(0),
                F::from(0),
                F::from(0),
                F::from(0)
            ],
            false
        ));
    }
    #[test]
    fn add_carry_bits_cannot_be_witnessed_as_two() {
        assert!(ok([255, 255, 1, 0, 255, 1], true));
        assert!(!ok([0, 0, 2, 0, 2, 0], true));
        assert!(!ok([255, 255, 2, 0, 0, 2], true));
    }
}

#[cfg(feature = "snapshot-prototype")]
pub mod snapshot;

#[cfg(feature = "public-hash-ffi")]
mod ffi;

pub mod carry;
