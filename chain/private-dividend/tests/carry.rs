use halo2_proofs::dev::MockProver;
use num_bigint::BigUint;
use uain_private_dividend::carry::{CarryCircuit, CarryWitness};
fn n(v: &str) -> BigUint {
    v.parse().unwrap()
}
fn bytes<const N: usize>(v: &BigUint) -> [u8; N] {
    let raw = v.to_bytes_le();
    assert!(raw.len() <= N);
    let mut out = [0; N];
    out[..raw.len()].copy_from_slice(&raw);
    out
}
fn witness(p: &BigUint, v: &BigUint, m: &BigUint, previous: &BigUint) -> CarryWitness {
    let total = p * v + previous;
    CarryWitness {
        pool: bytes(p),
        holding: bytes(v),
        minted: bytes(m),
        quotient: bytes(&(&total / m)),
        previous: bytes(previous),
        next: bytes(&(&total % m)),
    }
}
fn ok(w: CarryWitness) -> bool {
    MockProver::run(
        11,
        &CarryCircuit::from_witness(w.clone()),
        vec![w.public_inputs()],
    )
    .unwrap()
    .verify()
    .is_ok()
}
#[test]
fn carry_exact_induction_preserves_owner_total_above_u64_and_note_splitting() {
    let p = n("999999999999999999999999999999999999999999999999999999999999999999999999999999");
    let m = n("108000000000000000000");
    for chunks in [
        vec![n("13"), n("13")],
        vec![n("26")],
        vec![
            n("18446744073709551615"),
            n("18446744073709551615"),
            n("18446744073709551615"),
        ],
    ] {
        let mut r = n("0");
        let mut paid = n("0");
        let mut holding = n("0");
        for v in chunks {
            let w = witness(&p, &v, &m, &r);
            assert!(ok(w.clone()));
            r = BigUint::from_bytes_le(&w.next);
            paid += BigUint::from_bytes_le(&w.quotient);
            holding += v;
            assert_eq!(&paid * &m + &r, &p * &holding);
        }
        assert_eq!(paid, (&p * &holding) / &m);
        assert_eq!(r, (&p * &holding) % &m);
    }
    // Per-note floors give54; a same-owner carry chain gives the exact55.
    let a = witness(&n("150"), &n("13"), &n("70"), &n("0"));
    let b = witness(
        &n("150"),
        &n("13"),
        &n("70"),
        &BigUint::from_bytes_le(&a.next),
    );
    assert!(ok(a.clone()) && ok(b.clone()));
    assert_eq!(
        BigUint::from_bytes_le(&a.quotient) + BigUint::from_bytes_le(&b.quotient),
        n("55")
    );
}
#[test]
fn actual_carry_constraints_reject_manipulated_values_and_unbounded_remainders() {
    let base = witness(&n("150"), &n("26"), &n("70"), &n("60"));
    assert!(ok(base.clone()));
    for field in 0..6 {
        let mut w = base.clone();
        match field {
            0 => w.pool[0] += 1,
            1 => w.holding[0] += 1,
            2 => w.minted[0] += 1,
            3 => w.quotient[0] += 1,
            4 => w.previous[0] += 1,
            _ => w.next[0] += 1,
        };
        assert!(!ok(w), "field {field}");
    }
    let mut w = base.clone();
    w.previous = bytes(&n("70"));
    w.quotient = bytes(&n("56"));
    w.next = bytes(&n("50"));
    assert!(!ok(w));
    let mut w = base;
    w.previous = bytes(&n("60"));
    w.quotient = bytes(&n("55"));
    w.next = bytes(&n("110"));
    assert!(!ok(w));
    assert!(!ok(witness(&n("150"), &n("0"), &n("70"), &n("0"))));
    assert!(!ok(witness(&n("150"), &n("71"), &n("70"), &n("0"))));
    assert!(!ok(witness(
        &n("150"),
        &n("1"),
        &n("108000000000000000001"),
        &n("0")
    )));
}
