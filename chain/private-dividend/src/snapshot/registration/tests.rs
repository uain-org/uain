use super::*;
use halo2_proofs::dev::MockProver;
use orchard::keys::{SpendAuthorizingKey, SpendingKey};
use pasta_curves::group::ff::Field;
use rand::{rngs::StdRng, SeedableRng};
fn fixture() -> (
    RegistrationCircuit,
    Vec<F>,
    orchard::primitives::redpallas::SigningKey<orchard::primitives::redpallas::SpendAuth>,
) {
    let mut rng = StdRng::seed_from_u64(0x5541494e524547);
    let sk = SpendingKey::random(&mut rng);
    let fvk = FullViewingKey::from(&sk);
    let alpha = pallas::Scalar::random(&mut rng);
    let (c, p) =
        RegistrationCircuit::from_parts(&fvk, alpha, F::from(7), [F::from(13), F::from(17)])
            .unwrap();
    (c, p, SpendAuthorizingKey::from(&sk).randomize(&alpha))
}
fn ok(c: &RegistrationCircuit, p: Vec<F>) -> bool {
    MockProver::run(REGISTRATION_K, c, vec![p])
        .unwrap()
        .verify()
        .is_ok()
}
#[test]
fn actual_registration_binds_control_secret_authority_blind_and_consent() {
    let (c, p, _) = fixture();
    assert!(ok(&c, p.clone()));
    let mut rng = StdRng::seed_from_u64(29);
    let other = FullViewingKey::from(&SpendingKey::random(&mut rng));
    let mut changed = c.clone();
    changed.nk = Value::known(*other.nk());
    assert!(!ok(&changed, p.clone()));
    let mut changed = c.clone();
    changed.ak = Value::known(SpendValidatingKey::from(other));
    assert!(!ok(&changed, p.clone()));
    let mut changed = c.clone();
    changed.blind = Value::known(F::from(8));
    assert!(!ok(&changed, p.clone()));
    for field in 0..PUBLIC_INPUTS {
        let mut changed = p.clone();
        changed[field] += F::one();
        assert!(!ok(&c, changed), "public field{field}")
    }
}
#[test]
fn registration_spend_signature_binds_original_member_context_and_control() {
    let (_, p, signer) = fixture();
    let mut rng = StdRng::seed_from_u64(3);
    let signature = signer.sign(&mut rng, &statement_bytes(&p).unwrap());
    verify_signature(&p, &signature).unwrap();
    for field in 0..PUBLIC_INPUTS {
        let mut changed = p.clone();
        changed[field] += F::one();
        assert!(verify_signature(&changed, &signature).is_err())
    }
    assert!(statement_bytes(&p[..PUBLIC_INPUTS - 1]).is_err());
    let mut noncanonical = p.clone();
    noncanonical[1] = F::from_u128(u128::MAX) + F::one();
    assert!(statement_bytes(&noncanonical).is_err());
    let other = SpendingKey::random(&mut rng);
    let wrong = SpendAuthorizingKey::from(&other).randomize(&pallas::Scalar::from(4));
    let signature = wrong.sign(&mut rng, &statement_bytes(&p).unwrap());
    assert!(verify_signature(&p, &signature).is_err());
}

#[cfg(feature = "public-hash-ffi")]
#[test]
fn actual_registration_proof_ffi_pins_compiled_circuit_and_rejects_forgery() {
    use halo2_proofs::{
        plonk::{create_proof, keygen_pk, keygen_vk},
        poly::commitment::Params,
        transcript::{Blake2bWrite, Challenge255},
    };
    use pasta_curves::vesta;
    let (mut c, mut p, signer) = fixture();
    let member = ed25519_dalek::SigningKey::from_bytes(&[44; 32])
        .verifying_key()
        .to_bytes();
    let ctx = native_context("uain-test-1", [1; 32], member, p[0]).unwrap();
    p[1] = ctx[0];
    p[2] = ctx[1];
    p[5] = hash::poseidon_hash_3(p[0], ctx[0], ctx[1]);
    c.public = Value::known(p.clone().try_into().unwrap());
    let mut rng = StdRng::seed_from_u64(42);
    let params = Params::<vesta::Affine>::new(REGISTRATION_K);
    let vk = keygen_vk(&params, &RegistrationCircuit::default()).unwrap();
    let pk = keygen_pk(&params, vk, &c).unwrap();
    let mut transcript = Blake2bWrite::<_, vesta::Affine, Challenge255<_>>::init(vec![]);
    create_proof(&params, &pk, &[c], &[&[&p]], &mut rng, &mut transcript).unwrap();
    let proof = transcript.finalize();
    let sig: [u8; 64] = (&signer.sign(&mut rng, &statement_bytes(&p).unwrap())).into();
    let public = p.iter().flat_map(|f| f.to_repr()).collect::<Vec<_>>();
    let verify = |public: &[u8], proof: &[u8], sig: &[u8; 64]| unsafe {
        crate::ffi::uain_dividend_registration_verify(
            public.as_ptr(),
            proof.as_ptr(),
            proof.len(),
            sig.as_ptr(),
        )
    };
    assert_eq!(verify(&public, &proof, &sig), 0);
    let mut bad = proof.clone();
    bad[12] ^= 1;
    assert_ne!(verify(&public, &bad, &sig), 0);
    let mut bad = proof.clone();
    bad.push(0);
    assert_ne!(verify(&public, &bad, &sig), 0);
    assert_ne!(verify(&public, &[], &sig), 0);
    assert_ne!(verify(&public, &vec![0; 65537], &sig), 0);
    for i in 0..PUBLIC_INPUTS {
        let mut bad = public.clone();
        bad[i * 32] ^= 1;
        assert_ne!(verify(&bad, &proof, &sig), 0)
    }
    let mut bad = sig;
    bad[0] ^= 1;
    assert_ne!(verify(&public, &proof, &bad), 0);
    if let Some(dir) = std::env::var_os("UAIN_DIVIDEND_REGISTRATION_RECEIPT") {
        let d = std::path::Path::new(&dir);
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("registration.proof"), proof).unwrap();
        std::fs::write(d.join("registration.public"), public).unwrap();
        std::fs::write(d.join("registration.signature"), sig).unwrap();
    }
}

#[test]
fn native_context_matches_exact_original_member_vector() {
    let mut genesis = [0; 32];
    genesis[0] = 1;
    let mut member = [0; 32];
    member[0] = 33;
    let ctx = native_context("uain-test-1", genesis, member, F::from(11)).unwrap();
    let got = ctx
        .iter()
        .flat_map(|f| f.to_repr()[..16].to_vec())
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    assert_eq!(
        got,
        "8351d8e93b2b5f6163456c92ecca7183f007f4e0a9c7b00b550cb31539728872"
    );
    assert!(native_context("uain-test-1", [0; 32], member, F::from(11)).is_err());
    assert!(native_context("wrong chain", genesis, member, F::from(11)).is_err());
}
