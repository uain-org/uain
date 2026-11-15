//! Fictional public proof fixtures only. No production/member key is accepted.
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

fn member(public: &[u8]) -> String {
    format!("uain1{}", hex::encode(&Sha256::digest(public)[..20]))
}
fn review(
    chain: [u8; 32],
    effects: [u8; 32],
    reviewer: &SigningKey,
    boundary: Option<(u8, [u8; 32], u64)>,
) -> ([u8; 32], serde_json::Value) {
    let purpose = if boundary.is_some() {
        [0x71; 32]
    } else {
        [9; 32]
    };
    let mut bytes = if boundary.is_some() {
        let mut b = b"UAIN/coin-boundary/approval/v1\0".to_vec();
        b.extend(Sha256::digest(b"verified-bounties-108t-micro-v1"));
        b
    } else {
        b"UAIN/private-exchange/approval/v1\0".to_vec()
    };
    bytes.extend(chain);
    bytes.extend(400u64.to_be_bytes());
    bytes.extend(0u64.to_be_bytes());
    bytes.extend(effects);
    bytes.extend(purpose);
    bytes.extend([2, 1]);
    bytes.extend(reviewer.verifying_key().as_bytes());
    if let Some((direction, owner, amount)) = boundary {
        bytes.push(direction);
        bytes.extend(&Sha256::digest(owner)[..20]);
        bytes.extend(amount.to_be_bytes());
    }
    let signature = reviewer.sign(&bytes).to_bytes();
    bytes.extend(signature);
    let mut receipt = serde_json::json!({"reviewer":member(reviewer.verifying_key().as_bytes()),"effects":hex::encode(effects),"purpose_commitment":hex::encode(purpose),"class":"neutral","expires_height":"400","licence_revision":"0","signature_hex":hex::encode(signature)});
    if let Some((direction, owner, amount)) = boundary {
        receipt["direction"] = serde_json::json!(if direction == 1 { "shield" } else { "exit" });
        receipt["member"] = serde_json::json!(member(&owner));
        receipt["amount"] = serde_json::json!(amount.to_string());
    }
    (Sha256::digest(bytes).into(), receipt)
}
fn witness(leaves: &[MerkleHashOrchard], position: u32) -> MerklePath {
    let mut nodes = leaves.to_vec();
    let mut index = position as usize;
    let mut path = [MerkleHashOrchard::empty_leaf(); 32];
    for (level, sibling) in path.iter_mut().enumerate() {
        let empty = MerkleHashOrchard::empty_root(Level::from(level as u8));
        *sibling = *nodes.get(index ^ 1).unwrap_or(&empty);
        nodes = nodes
            .chunks(2)
            .map(|pair| {
                MerkleHashOrchard::combine(
                    Level::from(level as u8),
                    &pair[0],
                    pair.get(1).unwrap_or(&empty),
                )
            })
            .collect();
        index /= 2;
    }
    MerklePath::from_parts(position, path)
}

#[test]
fn real_backed_entry_private_payment_and_exit_proof_chain() {
    // All seeds belong to this disposable fixture. Only public proofs, signatures
    // and commitments are written; spending/viewing keys are never exported.
    let sender = SpendingKey::from_bytes([1; 32]).unwrap();
    let recipient = SpendingKey::from_bytes([2; 32]).unwrap();
    let sf = FullViewingKey::from(&sender);
    let rf = FullViewingKey::from(&recipient);
    let reviewer = SigningKey::from_bytes(&[42; 32]);
    let sender_member = *SigningKey::from_bytes(&[5; 32]).verifying_key().as_bytes();
    let recipient_member = *SigningKey::from_bytes(&[6; 32]).verifying_key().as_bytes();
    let mut rng = StdRng::from_seed([29; 32]);
    let pk = ProvingKey::build(version().circuit_version());
    let chain: [u8; 32] = Sha256::digest(b"sdk-test-1").into();

    let mut entry = Builder::new(
        BundleType::DEFAULT,
        version(),
        version().default_flags(),
        Anchor::empty_tree(),
    )
    .unwrap();
    entry
        .add_output(
            Some(sf.to_ovk(Scope::External)),
            sf.address_at(0u32, Scope::External),
            NoteValue::from_raw(70),
            [0; 512],
        )
        .unwrap();
    let (entry, _) = entry.build::<i64>(&mut rng).unwrap().unwrap();
    assert_eq!(*entry.value_balance(), -70);
    let effect = effects(&entry).unwrap();
    let (entry_review, entry_approval) =
        review(chain, effect, &reviewer, Some((1, sender_member, 70)));
    let entry = entry
        .create_proof(&pk, &mut rng)
        .unwrap()
        .apply_signatures(
            &mut rng,
            signature_hash(&chain, 400, &entry_review, &effect),
            &[],
        )
        .unwrap();
    let entry_wire = encode(&entry).unwrap();
    verify(&entry_wire, &chain, 400, &entry_review).unwrap();
    let mut leaves: Vec<_> = entry
        .actions()
        .iter()
        .map(|a| MerkleHashOrchard::from_cmx(a.cmx()))
        .collect();
    let (position, _, note, _, _) = entry
        .decrypt_outputs_with_keys(&[sf.to_ivk(Scope::External)])
        .into_iter()
        .find(|(_, _, n, _, _)| n.value().inner() == 70)
        .unwrap();
    let path = witness(&leaves, position as u32);
    let anchor = path.root(note.commitment().into());
    let mut payment = Builder::new(
        BundleType::DEFAULT,
        version(),
        version().default_flags(),
        anchor,
    )
    .unwrap();
    payment.add_spend(sf.clone(), note, path).unwrap();
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
    let (payment_review, payment_approval) = review(chain, effect, &reviewer, None);
    let payment = payment
        .create_proof(&pk, &mut rng)
        .unwrap()
        .apply_signatures(
            &mut rng,
            signature_hash(&chain, 400, &payment_review, &effect),
            &[SpendAuthorizingKey::from(&sender)],
        )
        .unwrap();
    let payment_wire = encode(&payment).unwrap();
    verify(&payment_wire, &chain, 400, &payment_review).unwrap();
    leaves.extend(
        payment
            .actions()
            .iter()
            .map(|a| MerkleHashOrchard::from_cmx(a.cmx())),
    );
    let (position, _, note, _, _) = payment
        .decrypt_outputs_with_keys(&[rf.to_ivk(Scope::External)])
        .into_iter()
        .find(|(_, _, n, _, _)| n.value().inner() == 26)
        .unwrap();
    let path = witness(&leaves, 2 + position as u32);
    let anchor = path.root(note.commitment().into());
    let mut exit = Builder::new(
        BundleType::DEFAULT,
        version(),
        version().default_flags(),
        anchor,
    )
    .unwrap();
    exit.add_spend(rf.clone(), note, path).unwrap();
    for _ in 0..2 {
        exit.add_output(
            Some(rf.to_ovk(Scope::Internal)),
            rf.address_at(0u32, Scope::Internal),
            NoteValue::from_raw(0),
            [0; 512],
        )
        .unwrap();
    }
    let (exit, _) = exit.build::<i64>(&mut rng).unwrap().unwrap();
    assert_eq!(*exit.value_balance(), 26);
    let effect = effects(&exit).unwrap();
    let (exit_review, exit_approval) =
        review(chain, effect, &reviewer, Some((2, recipient_member, 26)));
    let exit = exit
        .create_proof(&pk, &mut rng)
        .unwrap()
        .apply_signatures(
            &mut rng,
            signature_hash(&chain, 400, &exit_review, &effect),
            &[SpendAuthorizingKey::from(&recipient)],
        )
        .unwrap();
    let exit_wire = encode(&exit).unwrap();
    verify(&exit_wire, &chain, 400, &exit_review).unwrap();
    assert!(verify(&entry_wire, &chain, 400, &exit_review).is_err());
    assert!(verify(&exit_wire, &chain, 400, &payment_review).is_err());
    assert!(verify(&payment_wire, &chain, 401, &payment_review).is_err());
    if let Ok(directory) = std::env::var("UAIN_PUBLIC_FIXTURE_DIR") {
        let directory = std::path::Path::new(&directory);
        std::fs::create_dir_all(directory).unwrap();
        for (name, wire, approval) in [
            ("coin-entry", entry_wire, entry_approval),
            ("coin-otc", payment_wire, payment_approval),
            ("coin-exit", exit_wire, exit_approval),
        ] {
            std::fs::write(directory.join(format!("{name}.bin")), wire).unwrap();
            std::fs::write(
                directory.join(format!("{name}-approval.json")),
                serde_json::to_vec_pretty(&approval).unwrap(),
            )
            .unwrap();
        }
    }
}
