use super::*;
use halo2_proofs::dev::MockProver;
fn amount<const N: usize>(v: u128) -> [u8; N] {
    let mut out = [0; N];
    let b = v.to_le_bytes();
    let n = N.min(b.len());
    out[..n].copy_from_slice(&b[..n]);
    out
}
fn arithmetic(previous: u128) -> crate::carry::CarryWitness {
    let total = 150 * 13 + previous;
    crate::carry::CarryWitness {
        pool: amount(150),
        holding: amount(13),
        minted: amount(70),
        quotient: amount(total / 70),
        previous: amount(previous),
        next: amount(total % 70),
    }
}
fn fixture(init: bool) -> (CarryControlCircuit, Vec<F>) {
    let w = arithmetic(if init { 0 } else { 60 });
    let control = F::from(11);
    let nk = F::from(17);
    let domain = F::from(23);
    let path = core::array::from_fn(|i| F::from(i as u64 + 31));
    CarryControlCircuit::from_parts(
        w,
        control,
        nk,
        domain,
        init,
        5,
        path,
        F::from(7),
        F::from(8),
        F::from(9),
    )
    .unwrap()
}
fn ok(c: &CarryControlCircuit, p: Vec<F>) -> bool {
    MockProver::run(CARRY_CONTROL_K, c, vec![p])
        .unwrap()
        .verify()
        .is_ok()
}
#[test]
fn actual_carry_branches_bind_receipt_control_prior_and_wide_outputs() {
    for init in [false, true] {
        let (c, p) = fixture(init);
        MockProver::run(CARRY_CONTROL_K, &c, vec![p.clone()])
            .unwrap()
            .assert_satisfied();
        for i in 0..p.len() {
            let mut bad = p.clone();
            bad[i] += F::one();
            assert!(!ok(&c, bad), "public field{i}")
        }
        let mut bad = c.clone();
        bad.init = Value::known(F::from(2));
        assert!(!ok(&bad, p.clone()));
        let mut bad = c.clone();
        bad.nk = Value::known(F::from(18));
        assert!(!ok(&bad, p.clone()));
        let mut bad = c.clone();
        bad.control = Value::known(F::from(12));
        assert!(!ok(&bad, p.clone()));
        let mut bad = c.clone();
        bad.domain = Value::known(F::from(24));
        assert!(!ok(&bad, p.clone()));
        let mut bad = c.clone();
        bad.next_blind = Value::known(F::from(10));
        assert!(!ok(&bad, p.clone()));
        let mut bad = c.clone();
        bad.asset_blind = Value::known(F::from(10));
        assert!(!ok(&bad, p.clone()));
    }
}
#[test]
fn initialization_requires_zero_previous_and_existing_carry_requires_membership() {
    // Recompute every amount/output for the nonzero previous remainder, so
    // rejection specifically requires the initialization r_previous=0 gate.
    let (c, p) = CarryControlCircuit::from_parts(
        arithmetic(60),
        F::from(11),
        F::from(17),
        F::from(23),
        true,
        5,
        core::array::from_fn(|i| F::from(i as u64 + 31)),
        F::from(7),
        F::from(8),
        F::from(9),
    )
    .unwrap();
    assert!(!ok(&c, p));
    let (c, p) = fixture(false);
    let mut bad = c.clone();
    bad.position = Value::known(6);
    assert!(!ok(&bad, p.clone()));
    let mut bad = c.clone();
    bad.path = bad.path.map(|mut p| {
        p[7] += F::one();
        p
    });
    assert!(!ok(&bad, p.clone()));
    let mut bad = c.clone();
    bad.previous_blind = Value::known(F::from(6));
    assert!(!ok(&bad, p.clone()));
    // The complete effect can be recomputed for an asserted new root. The
    // non-initial branch must still fail its independently computed path.
    let mut changed = p.clone();
    changed[0] += F::one();
    changed[5] = effects(changed[0], changed[1], changed[2], changed[3], changed[4]);
    let mut bad = c.clone();
    bad.public = Value::known(changed.clone().try_into().unwrap());
    assert!(!ok(&bad, changed));
}

#[test]
fn private_initialization_and_prior_spend_fences_are_stable_but_receipt_and_owner_scoped() {
    let control = F::from(11);
    let nk = F::from(17);
    let domain = F::from(23);
    let init = initialization_nullifier(nk, control, domain);
    for other in [
        initialization_nullifier(nk + F::one(), control, domain),
        initialization_nullifier(nk, control + F::one(), domain),
        initialization_nullifier(nk, control, domain + F::one()),
    ] {
        assert_ne!(init, other)
    }
    let (_, p) = fixture(true);
    let (_, other) = CarryControlCircuit::from_parts(
        arithmetic(0),
        control,
        nk,
        domain,
        true,
        6,
        [F::from(99); 32],
        F::from(27),
        F::from(28),
        F::from(29),
    )
    .unwrap();
    // Different outputs/path cannot produce a second initialization fence.
    assert_eq!(p[2], other[2]);
    assert_ne!(p[3], other[3]);
    assert_ne!(p[4], other[4]);
    let prior = carry_commitment(control, domain, &amount(60), F::from(7));
    let nf = spend_nullifier(nk, prior);
    assert_ne!(nf, init);
    assert_ne!(nf, spend_nullifier(nk + F::one(), prior));
    let (_, a) = fixture(false);
    let (_, b) = CarryControlCircuit::from_parts(
        arithmetic(60),
        control,
        nk,
        domain,
        false,
        5,
        core::array::from_fn(|i| F::from(i as u64 + 31)),
        F::from(7),
        F::from(88),
        F::from(89),
    )
    .unwrap();
    // Both proposed forks consume the same private prior-carry nullifier. The
    // future native atomic spent set is still required to reject the second.
    assert_eq!(a[2], b[2]);
    assert_eq!(a[2], nf);
    assert_ne!(a[3], b[3]);
    assert_ne!(carry_leaf(prior), empty_leaf());
    assert_ne!(node(0, prior, prior), node(1, prior, prior));
}

#[test]
fn all_wide_asset_bytes_bind_without_field_reduction_and_large_holding_is_valid() {
    use num_bigint::BigUint;
    fn bytes<const N: usize>(v: &BigUint) -> [u8; N] {
        let raw = v.to_bytes_le();
        let mut out = [0; N];
        assert!(raw.len() <= N);
        out[..raw.len()].copy_from_slice(&raw);
        out
    }
    let p = BigUint::from_bytes_le(&crate::ATOMIC_CAP_LE);
    let m = BigUint::from(crate::SUPPLY_CAP);
    let v = BigUint::from(u64::MAX) + BigUint::from(1u8);
    let total = &p * &v;
    let w = CarryWitness {
        pool: bytes(&p),
        holding: bytes(&v),
        minted: bytes(&m),
        quotient: bytes(&(&total / &m)),
        previous: [0; 9],
        next: bytes(&(&total % &m)),
    };
    let control = F::from(11);
    let domain = F::from(23);
    let blind = F::from(9);
    let base = asset_commitment(control, domain, &w.quotient, blind);
    for i in 0..33 {
        let mut q = w.quotient;
        q[i] ^= 1;
        assert_ne!(
            base,
            asset_commitment(control, domain, &q, blind),
            "wide byte{i}"
        )
    }
    let (c, p) = CarryControlCircuit::from_parts(
        w,
        control,
        F::from(17),
        domain,
        true,
        0,
        [F::zero(); 32],
        F::from(7),
        F::from(8),
        blind,
    )
    .unwrap();
    assert!(ok(&c, p));
}

#[test]
fn actual_carry_control_proof_binds_outputs_and_exact_statement() {
    use halo2_proofs::{
        plonk::{create_proof, keygen_pk, keygen_vk, verify_proof, SingleVerifier},
        poly::commitment::Params,
        transcript::{Blake2bRead, Blake2bWrite, Challenge255},
    };
    use pasta_curves::vesta;
    use rand::SeedableRng;
    let (c, p) = fixture(false);
    let params = Params::<vesta::Affine>::new(CARRY_CONTROL_K);
    let vk = keygen_vk(&params, &CarryControlCircuit::default()).unwrap();
    let pk = keygen_pk(&params, vk, &CarryControlCircuit::default()).unwrap();
    let mut rng = rand::rngs::StdRng::seed_from_u64(0x5541494e434152);
    let mut write = Blake2bWrite::<_, vesta::Affine, Challenge255<_>>::init(vec![]);
    create_proof(&params, &pk, &[c], &[&[&p]], &mut rng, &mut write).unwrap();
    let proof = write.finalize();
    let verify = |bytes: &[u8], public: &[F]| {
        let mut cursor = std::io::Cursor::new(bytes);
        let mut read = Blake2bRead::<_, vesta::Affine, Challenge255<_>>::init(&mut cursor);
        let valid = verify_proof(
            &params,
            pk.get_vk(),
            SingleVerifier::new(&params),
            &[&[public]],
            &mut read,
        )
        .is_ok();
        drop(read);
        valid && cursor.position() == bytes.len() as u64
    };
    assert!(verify(&proof, &p));
    let mut changed = p.clone();
    changed[3] += F::one();
    assert!(!verify(&proof, &changed));
    let mut changed = proof.clone();
    changed[0] ^= 1;
    assert!(!verify(&changed, &p));
    let mut trailing = proof.clone();
    trailing.push(0);
    assert!(!verify(&trailing, &p));
    if let Ok(dir) = std::env::var("UAIN_DIVIDEND_CARRY_RECEIPT") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/proof.bin"), &proof).unwrap();
        std::fs::write(
            format!("{dir}/public.bin"),
            p.iter().flat_map(|v| v.to_repr()).collect::<Vec<u8>>(),
        )
        .unwrap();
    }
    eprintln!(
        "inactive diagnostic carry proof bytes={} public={} K={}",
        proof.len(),
        p.len(),
        CARRY_CONTROL_K
    );
}
