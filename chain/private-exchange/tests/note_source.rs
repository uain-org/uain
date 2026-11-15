//! Fictional encrypted-output ownership tests. Review encoding deliberately has
//! no valid authorization; the JS caller must first authenticate a real record.
#![cfg(unix)]
use orchard::{
    builder::{Builder, BundleType},
    keys::{FullViewingKey, Scope, SpendingKey},
    tree::Anchor,
    value::NoteValue,
};
use rand::{rngs::StdRng, SeedableRng};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
};
use uain_private_exchange::{effects, encode_for_review, version};
fn fixture(name: &str) -> (PathBuf, PathBuf, serde_json::Value, String) {
    let root =
        std::env::temp_dir().join(format!("uain-note-source-{}-{}", std::process::id(), name));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let owner = SpendingKey::from_bytes([2; 32]).unwrap();
    let other = SpendingKey::from_bytes([1; 32]).unwrap();
    let own = FullViewingKey::from(&owner);
    let foreign = FullViewingKey::from(&other);
    let key = root.join("fictional-key");
    fs::write(&key, [2u8; 32]).unwrap();
    fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();
    let mut rng = StdRng::from_seed([29; 32]);
    let mut builder = Builder::new(
        BundleType::DEFAULT,
        version(),
        version().default_flags(),
        Anchor::empty_tree(),
    )
    .unwrap();
    builder
        .add_output(
            Some(foreign.to_ovk(Scope::External)),
            own.address_at(0u32, Scope::External),
            NoteValue::from_raw(26),
            [0; 512],
        )
        .unwrap();
    builder
        .add_output(
            Some(foreign.to_ovk(Scope::External)),
            foreign.address_at(0u32, Scope::Internal),
            NoteValue::from_raw(44),
            [0; 512],
        )
        .unwrap();
    let (bundle, _) = builder.build::<i64>(&mut rng).unwrap().unwrap();
    let effect = hex::encode(effects(&bundle).unwrap());
    let input = serde_json::json!({"effects":effect,"bundle_hex":hex::encode(encode_for_review(&bundle).unwrap())});
    (
        root,
        key,
        input,
        hex::encode(own.address_at(0u32, Scope::External).to_raw_address_bytes()),
    )
}
fn invoke(path: &std::path::Path, input: &serde_json::Value) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_uain-note-source"))
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let written = child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes());
    let output = child.wait_with_output().unwrap();
    if let Err(error) = written {
        // Key validation may refuse the child before it reads any input.
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
        assert!(!output.status.success());
    }
    output
}
#[test]
fn decrypts_only_owned_outputs_and_never_exports_viewing_or_spending_material() {
    let (root, key, input, address) = fixture("owned");
    let out = invoke(&key, &input);
    assert!(out.status.success());
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 3);
    assert_eq!(value["effects"], input["effects"]);
    assert_eq!(value["positionScope"], "bundle-action");
    let notes = value["outputs"].as_array().unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].as_object().unwrap().len(), 5);
    assert_eq!(notes[0]["address"], address);
    assert_eq!(notes[0]["amount"], "26");
    assert!(notes[0]["position"].as_u64().unwrap() < 2);
    let decoded = uain_private_exchange::decode(&hex::decode(input["bundle_hex"].as_str().unwrap()).unwrap()).unwrap();
    let viewing = FullViewingKey::from(&SpendingKey::from_bytes([2; 32]).unwrap());
    let source = decoded.decrypt_outputs_with_keys(&[viewing.to_ivk(Scope::External), viewing.to_ivk(Scope::Internal)]);
    let (position, _, note, _, _) = &source[0];
    assert_eq!(notes[0]["commitment"], hex::encode(decoded.actions()[*position].cmx().to_bytes()));
    assert_eq!(notes[0]["nullifier"], hex::encode(note.nullifier(&viewing).to_bytes()));
    assert_eq!(notes[0]["commitment"].as_str().unwrap().len(), 64);
    assert_eq!(notes[0]["nullifier"].as_str().unwrap().len(), 64);
    assert!(out.stderr.is_empty());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_different_wallet_cannot_claim_the_recipient_output() {
    let (root, key, input, _) = fixture("foreign-note");
    fs::write(&key, [3u8; 32]).unwrap();
    let out = invoke(&key, &input);
    assert!(out.status.success());
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(value["outputs"].as_array().unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn both_owned_scopes_have_exact_commitments_and_stable_distinct_nullifiers() {
    let (root, key, _, _) = fixture("both-scopes");
    let viewing = FullViewingKey::from(&SpendingKey::from_bytes([2; 32]).unwrap());
    let mut rng = StdRng::from_seed([39; 32]);
    let mut builder = Builder::new(BundleType::DEFAULT, version(), version().default_flags(), Anchor::empty_tree()).unwrap();
    for (scope, amount) in [(Scope::External, 26), (Scope::Internal, 44)] {
        builder.add_output(Some(viewing.to_ovk(scope)), viewing.address_at(0u32, scope), NoteValue::from_raw(amount), [0; 512]).unwrap();
    }
    let (bundle, _) = builder.build::<i64>(&mut rng).unwrap().unwrap();
    let input = serde_json::json!({"effects":hex::encode(effects(&bundle).unwrap()),"bundle_hex":hex::encode(encode_for_review(&bundle).unwrap())});
    let first = invoke(&key, &input);
    assert!(first.status.success());
    let decoded: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    let outputs = decoded["outputs"].as_array().unwrap();
    assert_eq!(outputs.len(), 2);
    assert_ne!(outputs[0]["commitment"], outputs[1]["commitment"]);
    assert_ne!(outputs[0]["nullifier"], outputs[1]["nullifier"]);
    for output in outputs {
        let position = output["position"].as_u64().unwrap() as usize;
        assert_eq!(output["commitment"], hex::encode(bundle.actions()[position].cmx().to_bytes()));
        assert!([Scope::External, Scope::Internal].iter().any(|scope| output["address"] == hex::encode(viewing.address_at(0u32, *scope).to_raw_address_bytes())));
    }
    assert_eq!(first.stdout, invoke(&key, &input).stdout);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn refuses_effect_substitution_extra_fields_unbounded_or_noncanonical_wire() {
    let (root, key, input, _) = fixture("invalid");
    let mut wrong = input.clone();
    wrong["effects"] = serde_json::json!("f".repeat(64));
    let mut extra = input.clone();
    extra["private_key"] = serde_json::json!("forbidden");
    let mut upper = input.clone();
    upper["bundle_hex"] = serde_json::json!(input["bundle_hex"].as_str().unwrap().to_uppercase());
    for value in [
        wrong,
        extra,
        upper,
        serde_json::json!({"effects":"f".repeat(64),"bundle_hex":"0".repeat(65536)}),
    ] {
        let out = invoke(&key, &value);
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn refuses_symlink_and_real_foreign_owned_keys() {
    use std::os::unix::fs::{symlink, MetadataExt};
    let (root, key, input, _) = fixture("protected");
    let linked = root.join("linked");
    symlink(&key, &linked).unwrap();
    let out = invoke(&linked, &input);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    if let Some(path) = std::env::var_os("UAIN_TEST_FOREIGN_KEY_FILE") {
        let path = PathBuf::from(path);
        assert_ne!(fs::metadata(&path).unwrap().uid(), unsafe {
            libc::geteuid()
        });
        let out = invoke(&path, &input);
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
    }
    fs::remove_dir_all(root).unwrap();
}
