//! Real proof roundtrip of the diagnostic arithmetic harness; no entitlement or privacy claim.
use halo2_proofs::{
    plonk::{create_proof, keygen_pk, keygen_vk, verify_proof, SingleVerifier},
    poly::commitment::Params,
    transcript::{Blake2bRead, Blake2bWrite, Challenge255},
};
use pasta_curves::{pallas, EqAffine};
use rand::{rngs::StdRng, SeedableRng};
use uain_private_dividend::{RatioCircuit, RatioWitness};
#[test]
fn real_ratio_proof_rejects_changed_public_payout() {
    let mut w = RatioWitness {
        pool: [0; 33],
        holding: [0; 8],
        minted: [0; 9],
        quotient: [0; 33],
        remainder: [0; 9],
    };
    w.pool[0] = 150;
    w.holding[0] = 26;
    w.minted[0] = 70;
    w.quotient[0] = 55;
    w.remainder[0] = 50;
    let circuit = RatioCircuit::from_witness(w.clone());
    let params: Params<EqAffine> = Params::new(11);
    let vk = keygen_vk(&params, &circuit).unwrap();
    let pk = keygen_pk(&params, vk, &circuit).unwrap();
    let public = w.public_inputs();
    // Public test RNG seed only. No wallet randomness or private identities.
    let rng = StdRng::from_seed([0x73; 32]);
    let mut writer = Blake2bWrite::<_, _, Challenge255<_>>::init(vec![]);
    create_proof(&params, &pk, &[circuit], &[&[&public]], rng, &mut writer).unwrap();
    let proof = writer.finalize();
    let mut reader = Blake2bRead::<_, _, Challenge255<_>>::init(&proof[..]);
    verify_proof(
        &params,
        pk.get_vk(),
        SingleVerifier::new(&params),
        &[&[&public]],
        &mut reader,
    )
    .unwrap();
    // Preserve only this fully PUBLIC diagnostic proof when qualification asks.
    if let Ok(dir) = std::env::var("UAIN_DIVIDEND_PUBLIC_PROOF_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(std::path::Path::new(&dir).join("ratio-proof.bin"), &proof).unwrap();
        let bytes: Vec<u8> = w
            .pool
            .iter()
            .chain(&w.holding)
            .chain(&w.minted)
            .chain(&w.quotient)
            .chain(&w.remainder)
            .copied()
            .collect();
        std::fs::write(
            std::path::Path::new(&dir).join("ratio-public-input-bytes.bin"),
            bytes,
        )
        .unwrap();
    }
    let mut wrong = public;
    wrong[50] += pallas::Base::from(1);
    let mut reader = Blake2bRead::<_, _, Challenge255<_>>::init(&proof[..]);
    assert!(verify_proof(
        &params,
        pk.get_vk(),
        SingleVerifier::new(&params),
        &[&[&wrong]],
        &mut reader
    )
    .is_err());
}
