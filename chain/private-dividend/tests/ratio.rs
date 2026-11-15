use halo2_proofs::dev::MockProver;
use num_bigint::BigUint;
use uain_private_dividend::{RatioCircuit, RatioWitness, CLAIMS_ENABLED};

fn n(s: &str) -> BigUint {
    s.parse().unwrap()
}
fn bytes<const N: usize>(x: &BigUint) -> [u8; N] {
    let raw = x.to_bytes_le();
    assert!(raw.len() <= N);
    let mut b = [0; N];
    b[..raw.len()].copy_from_slice(&raw);
    b
}
fn witness(p: &BigUint, v: &BigUint, m: &BigUint) -> RatioWitness {
    let product = p * v;
    RatioWitness {
        pool: bytes(p),
        holding: bytes(v),
        minted: bytes(m),
        quotient: bytes(&(&product / m)),
        remainder: bytes(&(&product % m)),
    }
}
fn satisfied(w: RatioWitness) -> bool {
    let circuit = RatioCircuit::from_witness(w.clone());
    MockProver::run(11, &circuit, vec![w.public_inputs()])
        .unwrap()
        .verify()
        .is_ok()
}
#[test]
fn exact_integer_ratio_and_large_supply() {
    assert!(!CLAIMS_ENABLED);
    for (p, v, m) in [
        ("15", "26", "5000000"),
        ("150", "26", "70"),
        ("0", "1", "1"),
        ("150", "70", "70"),
        (
            "999999999999999999999999999999999999999999999999999999999999999999999999999999",
            "18446744073709551615",
            "108000000000000000000",
        ),
        (
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            "18446744073709551615",
            "108000000000000000000",
        ),
    ] {
        assert!(satisfied(witness(&n(p), &n(v), &n(m))));
    }
}
#[test]
fn rejects_manipulated_quotient_remainder_and_supply() {
    assert!(!satisfied(witness(
        &n("1000000000000000000000000000000000000000000000000000000000000000000000000000000"),
        &n("1"),
        &n("1")
    )));
    let base = witness(&n("150"), &n("26"), &n("70"));
    let mut wrong = base.clone();
    wrong.quotient[0] += 1;
    assert!(!satisfied(wrong));
    let mut wrong = base.clone();
    wrong.remainder[0] += 1;
    assert!(!satisfied(wrong));
    // q=54,r=120 satisfies the equality, but r>=M must fail.
    let mut wrong = base.clone();
    wrong.quotient = bytes(&n("54"));
    wrong.remainder = bytes(&n("120"));
    assert!(!satisfied(wrong));
    let mut wrong = base.clone();
    wrong.holding = [0; 8];
    wrong.quotient = [0; 33];
    wrong.remainder = [0; 9];
    assert!(!satisfied(wrong));
    let mut wrong = base;
    wrong.minted = [0; 9];
    assert!(!satisfied(wrong));
    assert!(!satisfied(witness(&n("150"), &n("71"), &n("70"))));
    assert!(!satisfied(witness(
        &n("150"),
        &n("1"),
        &n("108000000000000000001")
    )));
}
#[test]
fn public_inputs_bind_all_values() {
    let w = witness(&n("150"), &n("26"), &n("70"));
    let c = RatioCircuit::from_witness(w.clone());
    for i in [0, 33, 41, 50, 83] {
        let mut public = w.public_inputs();
        public[i] += pasta_curves::pallas::Base::from(1);
        assert!(MockProver::run(11, &c, vec![public])
            .unwrap()
            .verify()
            .is_err());
    }
}
#[test]
fn deterministic_wide_reference_cases() {
    let cap = n("108000000000000000000");
    let mut state = 0x1234567812345678u64;
    for i in 0..16 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let v = BigUint::from(state.max(1));
        let m = &v + BigUint::from(i * 937 + 1u64);
        let p = (BigUint::from(state) << 192usize) + BigUint::from(i * 31 + 1u64);
        assert!(m <= cap);
        assert!(satisfied(witness(&p, &v, &m)));
    }
}
