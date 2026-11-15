use super::*;
use halo2_proofs::dev::MockProver;

#[test]
fn composed_owned_snapshot_ratio_is_satisfied() {
    let f = fixture();
    MockProver::run(K, &f.circuit, vec![f.public])
        .unwrap()
        .assert_satisfied();
}

#[test]
fn anchored_roots_and_effects_cannot_be_substituted() {
    let f = fixture();
    for offset in [0, 1, 2, 3, 4, 5, 6, 7, 48] {
        let mut public = f.public.clone();
        public[offset] += pallas::Base::one();
        let mut c = f.circuit.clone();
        c.public = Value::known(public[..8].try_into().unwrap());
        assert!(
            MockProver::run(K, &c, vec![public])
                .unwrap()
                .verify()
                .is_err(),
            "offset {offset}"
        );
    }
}

#[test]
fn hidden_holding_and_payout_must_bind_same_owned_note() {
    let f = fixture();
    let mut c = f.circuit.clone();
    c.ratio.as_mut().unwrap().holding = 26_000_000u64.to_le_bytes();
    c.ratio.as_mut().unwrap().quotient[..8].copy_from_slice(&3_000_000u64.to_le_bytes());
    assert!(MockProver::run(K, &c, vec![f.public.clone()])
        .unwrap()
        .verify()
        .is_err());
    let mut c = f.circuit.clone();
    c.ratio.as_mut().unwrap().quotient[0] += 1;
    assert!(MockProver::run(K, &c, vec![f.public])
        .unwrap()
        .verify()
        .is_err());
}

use incrementalmerkletree::{Hashable, Level};
use orchard::{
    keys::{SpendAuthorizingKey, SpendingKey},
    note::{commitment::ExtractedNoteCommitment, Rho},
    primitives::redpallas::SpendAuth,
};
use pasta_curves::group::ff::Field;
use rand::SeedableRng;

struct Fixture {
    circuit: SnapshotCircuit,
    public: Vec<pallas::Base>,
    nf: pallas::Base,
    note: Note,
    path: [MerkleHashOrchard; 32],
    signer: orchard::primitives::redpallas::SigningKey<SpendAuth>,
}
fn fixture() -> Fixture {
    let mut rng = rand::rngs::StdRng::seed_from_u64(0x5541494e);
    let sk = SpendingKey::random(&mut rng);
    let fvk = FullViewingKey::from(&sk);
    let (_, _, parent) = Note::dummy(&mut rng, None, NoteVersion::V2);
    let note = Note::new(
        fvk.address_at(0u32, Scope::External),
        NoteValue::from_raw(13_000_000),
        Rho::from_nf_old(parent.nullifier(&fvk)),
        NoteVersion::V2,
        &mut rng,
    );
    let leaf = ExtractedNoteCommitment::from(note.commitment());
    let mut root = MerkleHashOrchard::from_cmx(&leaf);
    let mut path = [MerkleHashOrchard::empty_leaf(); 32];
    for i in 0..32 {
        path[i] = MerkleHashOrchard::empty_root(Level::from(i as u8));
        root = MerkleHashOrchard::combine(Level::from(i as u8), &root, &path[i]);
    }
    let provider = imt::SpacedLeafImtProvider::new();
    let nf = note.nullifier(&fvk).inner();
    use imt::ImtProvider;
    let imt = provider.non_membership_proof(nf).unwrap();
    let alpha = pallas::Scalar::random(&mut rng);
    let mut pool = [0u8; 33];
    pool[..8].copy_from_slice(&3_000_000u64.to_le_bytes());
    let mut minted = [0u8; 9];
    minted[..8].copy_from_slice(&26_000_000u64.to_le_bytes());
    let mut quotient = [0u8; 33];
    quotient[..8].copy_from_slice(&1_500_000u64.to_le_bytes());
    let ratio = RatioWitness {
        pool,
        holding: 13_000_000u64.to_le_bytes(),
        minted,
        quotient,
        remainder: [0; 9],
    };
    let (circuit, public) = SnapshotCircuit::from_parts(
        &fvk,
        &note,
        Scope::External,
        alpha,
        root.inner(),
        path,
        0,
        &imt,
        ratio,
        [pallas::Base::from(42), pallas::Base::from(9)],
        [pallas::Base::from(3), pallas::Base::from(4)],
        pallas::Base::random(&mut rng),
    )
    .unwrap();
    let signer = SpendAuthorizingKey::from(&sk).randomize(&alpha);
    Fixture {
        circuit,
        public,
        nf,
        note,
        path,
        signer,
    }
}

#[test]
fn actual_spent_nullifier_cannot_pass_valid_occupied_leaf_path() {
    use imt::ImtProvider;
    let f = fixture();
    let spent = imt::SpacedLeafImtProvider::with_extra_nullifiers(&[f.nf]);
    assert!(spent.non_membership_proof(f.nf).is_err());
    let proof = spent.occupied_leaf_for_test(f.nf);
    let mut c = f.circuit.clone();
    let mut public = f.public.clone();
    public[1] = proof.root;
    c.public = Value::known(public[..8].try_into().unwrap());
    c.note.imt_nf_bounds = Value::known(proof.nf_bounds);
    c.note.imt_leaf_pos = Value::known(proof.leaf_pos);
    c.note.imt_path = Value::known(proof.path);
    assert!(MockProver::run(K, &c, vec![public])
        .unwrap()
        .verify()
        .is_err());
    // A spend after H does not invalidate the independently authenticated old root.
    MockProver::run(K, &f.circuit, vec![f.public])
        .unwrap()
        .assert_satisfied();
}

#[test]
fn owner_and_single_reviewer_authorizations_bind_entire_statement() {
    use authorization::*;
    use ed25519_dalek::Signer;
    let f = fixture();
    let message = statement_bytes(&f.public).unwrap();
    let mut rng = rand::rngs::StdRng::seed_from_u64(9);
    let signature = f.signer.sign(&mut rng, &message);
    verify_spend_signature(&f.public, &signature).unwrap();
    for i in [0, 1, 2, 3, 4, 5, 6, 7, 8, 49] {
        let mut public = f.public.clone();
        public[i] += pallas::Base::one();
        assert!(verify_spend_signature(&public, &signature).is_err());
    }
    let reviewer = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let approval = LicensedApproval {
        valid_until: 100,
        signature: reviewer
            .sign(&review_message(&f.public, 100).unwrap())
            .to_bytes(),
    };
    let pinned = reviewer.verifying_key().to_bytes();
    verify_licensed_approval(&f.public, &approval, pinned, 99).unwrap();
    assert!(verify_licensed_approval(&f.public, &approval, pinned, 101).is_err());
    let mut changed = f.public.clone();
    changed[7] += pallas::Base::one();
    assert!(verify_licensed_approval(&changed, &approval, pinned, 99).is_err());
    assert!(verify_licensed_approval(&f.public, &approval, [8; 32], 99).is_err());
    let mut quotient = f.circuit.ratio.as_ref().unwrap().quotient;
    let mut recipient = [pallas::Base::from(3), pallas::Base::from(4)];
    // Extract only this deterministic fictional fixture's effect blinding value.
    let mut blind = pallas::Base::zero();
    f.circuit.effect_blind.map(|b| blind = b);
    verify_effect_opening(&f.public, recipient, quotient, blind).unwrap();
    quotient[0] += 1;
    assert!(verify_effect_opening(&f.public, recipient, quotient, blind).is_err());
    quotient[0] -= 1;
    recipient[0] += pallas::Base::one();
    assert!(verify_effect_opening(&f.public, recipient, quotient, blind).is_err());
}

#[test]
fn composed_real_proof_requires_pinned_roots_owner_review_and_exact_effects() {
    use authorization::*;
    use ed25519_dalek::Signer;
    use halo2_proofs::{
        plonk::{create_proof, keygen_pk, keygen_vk},
        poly::commitment::Params,
        transcript::{Blake2bWrite, Challenge255},
    };
    use pasta_curves::vesta;
    let f = fixture();
    let params = Params::<vesta::Affine>::new(K);
    let vk = keygen_vk(&params, &f.circuit).unwrap();
    let pk = keygen_pk(&params, vk, &f.circuit).unwrap();
    let mut rng = rand::rngs::StdRng::seed_from_u64(777);
    let mut transcript = Blake2bWrite::<_, vesta::Affine, Challenge255<_>>::init(vec![]);
    create_proof(
        &params,
        &pk,
        &[f.circuit.clone()],
        &[&[&f.public]],
        &mut rng,
        &mut transcript,
    )
    .unwrap();
    let proof = transcript.finalize();
    let spend = f
        .signer
        .sign(&mut rng, &statement_bytes(&f.public).unwrap());
    let reviewer = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let review = LicensedApproval {
        valid_until: 100,
        signature: reviewer
            .sign(&review_message(&f.public, 100).unwrap())
            .to_bytes(),
    };
    let reviewer_key = reviewer.verifying_key().to_bytes();
    let ratio = f.circuit.ratio.as_ref().unwrap();
    let mut pin = PinnedSnapshot {
        note_root: f.public[0],
        nullifier_root: f.public[1],
        context: [f.public[2], f.public[3]],
        pool: ratio.pool,
        minted: ratio.minted,
    };
    verify_candidate(
        &params,
        pk.get_vk(),
        &pin,
        &f.public,
        &proof,
        &spend,
        &review,
        reviewer_key,
        99,
    )
    .unwrap();
    // Proof tamper is rejected after both valid owner and reviewer signatures.
    let mut broken = proof.clone();
    broken[300] ^= 1;
    assert!(verify_candidate(
        &params,
        pk.get_vk(),
        &pin,
        &f.public,
        &broken,
        &spend,
        &review,
        reviewer_key,
        99
    )
    .is_err());
    let mut trailing = proof.clone();
    trailing.push(0);
    assert!(verify_candidate(
        &params,
        pk.get_vk(),
        &pin,
        &f.public,
        &trailing,
        &spend,
        &review,
        reviewer_key,
        99
    )
    .is_err());
    pin.nullifier_root += pallas::Base::one();
    assert!(verify_candidate(
        &params,
        pk.get_vk(),
        &pin,
        &f.public,
        &proof,
        &spend,
        &review,
        reviewer_key,
        99
    )
    .is_err());
    pin.nullifier_root -= pallas::Base::one();
    pin.minted[0] ^= 1;
    assert!(pin.matches(&f.public).is_err());
    pin.minted[0] ^= 1;
    pin.pool[0] ^= 1;
    assert!(pin.matches(&f.public).is_err());
    if let Some(dir) = std::env::var_os("UAIN_DIVIDEND_ARTIFACT_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        let d = std::path::PathBuf::from(dir);
        std::fs::write(d.join("snapshot-ratio-proof.bin"), &proof).unwrap();
        std::fs::write(
            d.join("snapshot-ratio-public-fields.bin"),
            f.public
                .iter()
                .flat_map(|v| v.to_repr())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        // Only public signatures are preserved; no key/note/opening files.
        std::fs::write(
            d.join("snapshot-owner-signature.bin"),
            <[u8; 64]>::from(&spend),
        )
        .unwrap();
        std::fs::write(d.join("snapshot-review-signature.bin"), review.signature).unwrap();
        std::fs::write(d.join("snapshot-reviewer-public-key.bin"), reviewer_key).unwrap();
    }
}

#[test]
fn different_owner_cannot_claim_note_even_with_recomputed_public_effects() {
    use imt::ImtProvider;
    let f = fixture();
    let mut rng = rand::rngs::StdRng::seed_from_u64(99);
    let attacker = SpendingKey::random(&mut rng);
    let fvk = FullViewingKey::from(&attacker);
    let provider = imt::SpacedLeafImtProvider::new();
    let wrong_nf = f.note.nullifier(&fvk).inner();
    let proof = provider.non_membership_proof(wrong_nf).unwrap();
    let (c, public) = SnapshotCircuit::from_parts(
        &fvk,
        &f.note,
        Scope::External,
        pallas::Scalar::random(&mut rng),
        f.public[0],
        f.path,
        0,
        &proof,
        f.circuit.ratio.unwrap(),
        [f.public[2], f.public[3]],
        [pallas::Base::from(3), pallas::Base::from(4)],
        pallas::Base::from(19),
    )
    .unwrap();
    assert!(MockProver::run(K, &c, vec![public])
        .unwrap()
        .verify()
        .is_err());
}
#[test]
fn receipt_nullifier_changes_with_receipt_and_replay_fails_same_statement() {
    let f = fixture();
    let mut c = f.circuit.clone();
    let mut public = f.public.clone();
    public[2] += pallas::Base::one();
    c.public = Value::known(public[..8].try_into().unwrap());
    // Reusing old claim NF after changing receipt fails the actual hash relation.
    assert!(MockProver::run(K, &c, vec![public.clone()])
        .unwrap()
        .verify()
        .is_err());
    let mut nk = pallas::Base::zero();
    c.nk.map(|n| nk = n.inner());
    let domain = hash::poseidon_hash_3(domain_tag(), public[2], public[3]);
    public[6] = hash::poseidon_hash_3(nk, domain, f.nf);
    assert_ne!(public[6], f.public[6]);
    let mut blind = pallas::Base::zero();
    c.effect_blind.map(|b| blind = b);
    let mut effect = hash::poseidon_hash_3(domain, public[6], blind);
    effect = hash::poseidon_hash_3(effect, pallas::Base::from(3), pallas::Base::from(4));
    for b in c.ratio.as_ref().unwrap().quotient {
        effect = hash::poseidon_hash_2(effect, pallas::Base::from(b as u64));
    }
    public[7] = effect;
    c.public = Value::known(public[..8].try_into().unwrap());
    MockProver::run(K, &c, vec![public])
        .unwrap()
        .assert_satisfied();
    // Ledger duplicate rejection still needs an atomic persistent native fence;
    // this test proves scope/derivation only, not a keeper implementation.
}

fn full_fixture() -> (FullSnapshotCircuit, Fixture, smt::SparseTree) {
    let mut f = fixture();
    let mut tree = smt::SparseTree::new();
    tree.insert(pallas::Base::zero().to_repr()).unwrap();
    let path = tree.path(f.nf.to_repr()).unwrap().try_into().unwrap();
    f.public[1] = tree.root();
    f.circuit.public = Value::known(f.public[..8].try_into().unwrap());
    (
        FullSnapshotCircuit {
            witness: f.circuit.clone(),
            sparse_path: Value::known(path),
        },
        f,
        tree,
    )
}
#[test]
fn full_domain_owned_note_composition_rejects_spent_and_inflated_holding() {
    let (c, f, mut tree) = full_fixture();
    MockProver::run(FULL_SNAPSHOT_K, &c, vec![f.public.clone()])
        .unwrap()
        .assert_satisfied();
    let mut inflated = c.clone();
    inflated.witness.ratio.as_mut().unwrap().holding = 26_000_000u64.to_le_bytes();
    inflated.witness.ratio.as_mut().unwrap().quotient[..8]
        .copy_from_slice(&3_000_000u64.to_le_bytes());
    assert!(
        MockProver::run(FULL_SNAPSHOT_K, &inflated, vec![f.public.clone()])
            .unwrap()
            .verify()
            .is_err()
    );
    tree.insert(f.nf.to_repr()).unwrap();
    let mut occupied = c;
    occupied.sparse_path = Value::known(tree.path(f.nf.to_repr()).unwrap().try_into().unwrap());
    let mut public = f.public;
    public[1] = tree.root();
    occupied.witness.public = Value::known(public[..8].try_into().unwrap());
    assert!(MockProver::run(FULL_SNAPSHOT_K, &occupied, vec![public])
        .unwrap()
        .verify()
        .is_err());
}

#[test]
fn full_domain_real_proof_requires_pinned_snapshot_owner_review_and_effects() {
    use authorization::*;
    use ed25519_dalek::Signer;
    use halo2_proofs::{
        plonk::{create_proof, keygen_pk, keygen_vk},
        poly::commitment::Params,
        transcript::{Blake2bWrite, Challenge255},
    };
    use pasta_curves::vesta;
    let (c, f, _) = full_fixture();
    let params = Params::<vesta::Affine>::new(FULL_SNAPSHOT_K);
    let vk = keygen_vk(&params, &c).unwrap();
    let pk = keygen_pk(&params, vk, &c).unwrap();
    let mut rng = rand::rngs::StdRng::seed_from_u64(777);
    let mut transcript = Blake2bWrite::<_, vesta::Affine, Challenge255<_>>::init(vec![]);
    create_proof(
        &params,
        &pk,
        &[c.clone()],
        &[&[&f.public]],
        &mut rng,
        &mut transcript,
    )
    .unwrap();
    let proof = transcript.finalize();
    let spend = f
        .signer
        .sign(&mut rng, &statement_bytes(&f.public).unwrap());
    let reviewer = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let review = LicensedApproval {
        valid_until: 100,
        signature: reviewer
            .sign(&review_message(&f.public, 100).unwrap())
            .to_bytes(),
    };
    let reviewer_key = reviewer.verifying_key().to_bytes();
    let ratio = f.circuit.ratio.as_ref().unwrap();
    let mut pin = PinnedSnapshot {
        note_root: f.public[0],
        nullifier_root: f.public[1],
        context: [f.public[2], f.public[3]],
        pool: ratio.pool,
        minted: ratio.minted,
    };
    verify_full_candidate(
        &params,
        pk.get_vk(),
        &pin,
        &f.public,
        &proof,
        &spend,
        &review,
        reviewer_key,
        99,
    )
    .unwrap();
    // Proof tamper is rejected after both valid owner and reviewer signatures.
    let mut broken = proof.clone();
    broken[300] ^= 1;
    assert!(verify_full_candidate(
        &params,
        pk.get_vk(),
        &pin,
        &f.public,
        &broken,
        &spend,
        &review,
        reviewer_key,
        99
    )
    .is_err());
    let mut trailing = proof.clone();
    trailing.push(0);
    assert!(verify_full_candidate(
        &params,
        pk.get_vk(),
        &pin,
        &f.public,
        &trailing,
        &spend,
        &review,
        reviewer_key,
        99
    )
    .is_err());
    pin.nullifier_root += pallas::Base::one();
    assert!(verify_full_candidate(
        &params,
        pk.get_vk(),
        &pin,
        &f.public,
        &proof,
        &spend,
        &review,
        reviewer_key,
        99
    )
    .is_err());
    pin.nullifier_root -= pallas::Base::one();
    pin.minted[0] ^= 1;
    assert!(pin.matches(&f.public).is_err());
    pin.minted[0] ^= 1;
    pin.pool[0] ^= 1;
    assert!(pin.matches(&f.public).is_err());
    if let Some(dir) = std::env::var_os("UAIN_DIVIDEND_FULL_ARTIFACT_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        let d = std::path::PathBuf::from(dir);
        std::fs::write(d.join("snapshot-ratio-proof.bin"), &proof).unwrap();
        std::fs::write(
            d.join("snapshot-ratio-public-fields.bin"),
            f.public
                .iter()
                .flat_map(|v| v.to_repr())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        // Only public signatures are preserved; no key/note/opening files.
        std::fs::write(
            d.join("snapshot-owner-signature.bin"),
            <[u8; 64]>::from(&spend),
        )
        .unwrap();
        std::fs::write(d.join("snapshot-review-signature.bin"), review.signature).unwrap();
        std::fs::write(d.join("snapshot-reviewer-public-key.bin"), reviewer_key).unwrap();
    }
}
