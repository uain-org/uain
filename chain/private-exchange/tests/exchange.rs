use ed25519_dalek::{Signer, SigningKey};
use incrementalmerkletree::{Hashable, Level};
use orchard::{
    builder::{Builder, BundleType},
    circuit::ProvingKey,
    keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey},
    tree::{Anchor, MerkleHashOrchard, MerklePath},
    value::NoteValue,
};
use rand::{rngs::StdRng, SeedableRng};
use sha2::{Digest, Sha256};
use uain_private_exchange::*;

#[test]
fn fixed_encoding_rejects_unbounded_and_invalid_inputs() {
    for bytes in [
        vec![],
        vec![0; wire_size()],
        vec![255; wire_size()],
        vec![0; wire_size() + 1],
        vec![0; wire_size() - 1],
    ] {
        assert!(decode(&bytes).is_err());
    }
    assert!(combine(32, [0; 32], [0; 32]).is_err());
    assert!(combine(0, [255; 32], [0; 32]).is_err());
    assert!(empty(33).is_err());
    assert_eq!(empty(32).unwrap(), Anchor::empty_tree().to_bytes());
}

#[test]
fn real_shielded_payment_and_adversarial_mutations() {
    // These keys are created only in this disposable test and never printed.
    let sender = SpendingKey::from_bytes([1; 32]).unwrap();
    let receiver = SpendingKey::from_bytes([2; 32]).unwrap();
    let stranger = SpendingKey::from_bytes([3; 32]).unwrap();
    let sf = FullViewingKey::from(&sender);
    let rf = FullViewingKey::from(&receiver);
    let mut rng = StdRng::from_seed([19; 32]);
    let pk = ProvingKey::build(version().circuit_version());
    let chain: [u8; 32] = Sha256::digest(b"uain-test-1").into();
    let expiry = 400;
    let approval = [8; 32];
    let mut deposit = Builder::new(
        BundleType::DEFAULT,
        version(),
        version().default_flags(),
        Anchor::empty_tree(),
    )
    .unwrap();
    deposit
        .add_output(
            Some(sf.to_ovk(Scope::External)),
            sf.address_at(0u32, Scope::External),
            NoteValue::from_raw(70),
            [0; 512],
        )
        .unwrap();
    let (deposit, _) = deposit.build::<i64>(&mut rng).unwrap().unwrap();
    assert_eq!(*deposit.value_balance(), -70);
    let hash = signature_hash(&chain, expiry, &approval, &effects(&deposit).unwrap());
    let deposit = deposit
        .create_proof(&pk, &mut rng)
        .unwrap()
        .apply_signatures(&mut rng, hash, &[])
        .unwrap();
    let db = encode(&deposit).unwrap();
    verify(&db, &chain, expiry, &approval).unwrap();
    let (idx, _, note, _, _) = deposit
        .decrypt_outputs_with_keys(&[sf.to_ivk(Scope::External)])
        .into_iter()
        .find(|(_, _, n, _, _)| n.value().inner() == 70)
        .unwrap();
    let mut path = [MerkleHashOrchard::empty_leaf(); 32];
    path[0] = MerkleHashOrchard::from_cmx(deposit.actions().get(1 - idx).unwrap().cmx());
    for (i, n) in path.iter_mut().enumerate().skip(1) {
        *n = MerkleHashOrchard::empty_root(Level::from(i as u8));
    }
    let witness = MerklePath::from_parts(idx as u32, path);
    let anchor = witness.root(note.commitment().into());
    let mut payment = Builder::new(
        BundleType::DEFAULT,
        version(),
        version().default_flags(),
        anchor,
    )
    .unwrap();
    payment.add_spend(sf.clone(), note, witness).unwrap();
    payment
        .add_output(
            Some(sf.to_ovk(Scope::External)),
            rf.address_at(0u32, Scope::External),
            NoteValue::from_raw(26),
            [5; 512],
        )
        .unwrap();
    payment
        .add_output(
            Some(sf.to_ovk(Scope::External)),
            sf.address_at(1u32, Scope::External),
            NoteValue::from_raw(44),
            [0; 512],
        )
        .unwrap();
    let (payment, _) = payment.build::<i64>(&mut rng).unwrap().unwrap();
    assert_eq!(*payment.value_balance(), 0);
    let effect = effects(&payment).unwrap();
    let reviewer = SigningKey::from_bytes(&[42; 32]);
    let mut review = b"UAIN/private-exchange/approval/v1\0".to_vec();
    review.extend(chain);
    review.extend((expiry as u64).to_be_bytes());
    review.extend(0u64.to_be_bytes());
    review.extend(effect);
    review.extend([9; 32]);
    review.extend([2, 1]);
    review.extend(reviewer.verifying_key().as_bytes());
    let signature = reviewer.sign(&review).to_bytes();
    review.extend(signature);
    let approval: [u8; 32] = Sha256::digest(&review).into();
    let hash = signature_hash(&chain, expiry, &approval, &effect);
    let payment = payment
        .create_proof(&pk, &mut rng)
        .unwrap()
        .apply_signatures(&mut rng, hash, &[SpendAuthorizingKey::from(&sender)])
        .unwrap();
    let wire = encode(&payment).unwrap();
    let checked = verify(&wire, &chain, expiry, &approval).unwrap();
    assert_eq!(effects(&checked).unwrap(), effect);
    assert_eq!(encode(&checked).unwrap(), wire);
    let received = checked.decrypt_outputs_with_keys(&[rf.to_ivk(Scope::External)]);
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].2.value().inner(), 26);
    assert_eq!(received[0].4, [5; 512]);
    let change = checked.decrypt_outputs_with_keys(&[sf.to_ivk(Scope::External)]);
    assert_eq!(change.len(), 1);
    assert_eq!(change[0].2.value().inner(), 44);
    assert!(checked
        .decrypt_outputs_with_keys(&[FullViewingKey::from(&stranger).to_ivk(Scope::External)])
        .is_empty());
    for (wrong_chain, wrong_expiry, wrong_approval) in [
        ([6; 32], expiry, approval),
        (chain, expiry + 1, approval),
        (chain, expiry, [9; 32]),
    ] {
        assert_eq!(
            verify(&wire, &wrong_chain, wrong_expiry, &wrong_approval).unwrap_err(),
            Error::Authorization
        );
    }
    let mut bad = wire.clone();
    bad[5] ^= 1;
    assert!(verify(&bad, &chain, expiry, &approval).is_err());
    let mut bad = wire.clone();
    bad[45 + 32 * 5] ^= 1;
    assert!(verify(&bad, &chain, expiry, &approval).is_err());
    let mut bad = wire.clone();
    bad[45 + 2 * (32 * 5 + 580 + 80 + 64)] ^= 1;
    assert_eq!(
        verify(&bad, &chain, expiry, &approval).unwrap_err(),
        Error::Proof
    );
    let mut bad = wire.clone();
    let last = bad.len() - 1;
    bad[last] ^= 1;
    assert!(verify(&bad, &chain, expiry, &approval).is_err());
    let mut bad = wire.clone();
    bad.extend([0]);
    assert!(decode(&bad).is_err());
    let mut bad = wire.clone();
    bad[45 + 64..45 + 96].fill(0);
    assert!(decode(&bad).is_err()); // identity randomized spend key
    let mut bad = wire.clone();
    bad[45 + 128..45 + 160].fill(0);
    assert!(decode(&bad).is_err()); // identity ephemeral encryption key
    if let Ok(dir) = std::env::var("UAIN_PUBLIC_FIXTURE_DIR") {
        let p = std::path::Path::new(&dir);
        std::fs::create_dir_all(p).unwrap();
        std::fs::write(p.join("deposit-owned-position.txt"), idx.to_string()).unwrap();
        std::fs::write(p.join("deposit.bin"), db).unwrap();
        std::fs::write(p.join("payment.bin"), wire).unwrap();
        std::fs::write(p.join("payment-effects.hex"), hex::encode(effect)).unwrap();
        std::fs::write(p.join("payment-sighash.hex"), hex::encode(hash)).unwrap();
        std::fs::write(p.join("approval-signature.hex"), hex::encode(signature)).unwrap();
        std::fs::write(
            p.join("reviewer-public-key.hex"),
            hex::encode(reviewer.verifying_key().as_bytes()),
        )
        .unwrap();
        std::fs::write(p.join("deposit-anchor.hex"), hex::encode(anchor.to_bytes())).unwrap();
    }
    println!("REAL_ORCHARD_EXCHANGE_OK actions=2 value_balance=0 recipient_decryption=26 change=44 wrong_keys=refused mutations=refused");
}
