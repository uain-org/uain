//! Inactive exact owner/receipt carry arithmetic. This chip alone proves no
//! owner, historical origin, carry membership, nullifier fence or asset output.
use crate::*;
#[derive(Clone, Debug)]
pub struct CarryWitness {
    pub pool: [u8; 33],
    pub holding: [u8; 9],
    pub minted: [u8; 9],
    pub quotient: [u8; 33],
    pub previous: [u8; 9],
    pub next: [u8; 9],
}
impl CarryWitness {
    pub fn public_inputs(&self) -> Vec<F> {
        self.pool
            .iter()
            .chain(&self.holding)
            .chain(&self.minted)
            .chain(&self.quotient)
            .chain(&self.previous)
            .chain(&self.next)
            .map(|b| F::from(*b as u64))
            .collect()
    }
}
#[derive(Clone, Debug)]
pub struct CarryCells {
    pub pool: Vec<ByteCell>,
    pub holding: Vec<ByteCell>,
    pub minted: Vec<ByteCell>,
    pub quotient: Vec<ByteCell>,
    pub previous: Vec<ByteCell>,
    pub next: Vec<ByteCell>,
}
impl CarryCells {
    fn all(&self) -> impl Iterator<Item = &ByteCell> {
        self.pool
            .iter()
            .chain(&self.holding)
            .chain(&self.minted)
            .chain(&self.quotient)
            .chain(&self.previous)
            .chain(&self.next)
    }
}
pub struct CarryChip {
    config: RatioConfig,
}
impl CarryChip {
    pub fn construct(config: RatioConfig) -> Self {
        Self { config }
    }
    pub fn assign(
        &self,
        l: &mut impl Layouter<F>,
        w: Option<&CarryWitness>,
    ) -> Result<CarryCells, Error> {
        l.assign_table(
            || "carry unsigned byte table",
            |mut t| {
                for i in 0..256 {
                    t.assign_cell(
                        || "byte",
                        self.config.table,
                        i,
                        || Value::known(F::from(i as u64)),
                    )?
                }
                Ok(())
            },
        )?;
        l.assign_region(
            || "exact owner carry arithmetic",
            |mut region| {
                let mut s = Arithmetic {
                    config: &self.config,
                    region: &mut region,
                    row: 0,
                };
                let zero = s.constant(0)?;
                let one = s.constant(1)?;
                let pool = s.load(w.map(|v| v.pool.as_slice()), 33)?;
                let holding = s.load(w.map(|v| v.holding.as_slice()), 9)?;
                let minted = s.load(w.map(|v| v.minted.as_slice()), 9)?;
                let quotient = s.load(w.map(|v| v.quotient.as_slice()), 33)?;
                let previous = s.load(w.map(|v| v.previous.as_slice()), 9)?;
                let next = s.load(w.map(|v| v.next.as_slice()), 9)?;
                let cap = s.load(Some(&ATOMIC_CAP_LE), 33)?;
                for (b, v) in cap.iter().zip(ATOMIC_CAP_LE) {
                    s.region
                        .constrain_constant(b.cell.cell(), F::from(v as u64))?;
                }
                let gap = s.difference(&cap, &pool, 0)?;
                let checked = s.add_bytes(&gap, &pool, &zero, &zero)?;
                s.equal_bytes(&checked, &cap, &zero)?;
                let numerator = s.multiply(&pool, &holding, &zero)?;
                let left = s.add_bytes(&numerator, &previous, &zero, &zero)?;
                let product = s.multiply(&quotient, &minted, &zero)?;
                let right = s.add_bytes(&product, &next, &zero, &zero)?;
                s.equal_bytes(&left, &right, &zero)?;
                for remainder in [&previous, &next] {
                    let gap = s.difference(&minted, remainder, 1)?;
                    let checked = s.add_bytes(&gap, remainder, &one, &zero)?;
                    s.equal_bytes(&checked, &minted, &zero)?;
                }
                let gap = s.difference(&minted, &holding, 0)?;
                let checked = s.add_bytes(&gap, &holding, &zero, &zero)?;
                s.equal_bytes(&checked, &minted, &zero)?;
                let raw = SUPPLY_CAP.to_le_bytes();
                let supply = s.load(Some(&raw[..9]), 9)?;
                for (b, v) in supply.iter().zip(raw) {
                    s.region
                        .constrain_constant(b.cell.cell(), F::from(v as u64))?;
                }
                let gap = s.difference(&supply, &minted, 0)?;
                let checked = s.add_bytes(&gap, &minted, &zero, &zero)?;
                s.equal_bytes(&checked, &supply, &zero)?;
                let gap = s.difference(&holding, &[], 1)?;
                let checked = s.add_bytes(&gap, &[], &one, &zero)?;
                s.equal_bytes(&checked, &holding, &zero)?;
                Ok(CarryCells {
                    pool,
                    holding,
                    minted,
                    quotient,
                    previous,
                    next,
                })
            },
        )
    }
}
/// Diagnostic constraint harness: all inputs exposed. Never use as a claim route.
#[derive(Clone, Default)]
pub struct CarryCircuit {
    witness: Option<CarryWitness>,
}
impl CarryCircuit {
    pub fn from_witness(w: CarryWitness) -> Self {
        Self { witness: Some(w) }
    }
}
impl Circuit<F> for CarryCircuit {
    type Config = RatioConfig;
    type FloorPlanner = SimpleFloorPlanner;
    fn without_witnesses(&self) -> Self {
        Self::default()
    }
    fn configure(m: &mut ConstraintSystem<F>) -> RatioConfig {
        RatioChip::configure(m)
    }
    fn synthesize(&self, c: RatioConfig, mut l: impl Layouter<F>) -> Result<(), Error> {
        let cells = CarryChip::construct(c.clone()).assign(&mut l, self.witness.as_ref())?;
        for (i, b) in cells.all().enumerate() {
            l.constrain_instance(b.cell.cell(), c.instance, i)?
        }
        Ok(())
    }
}
