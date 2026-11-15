//! Public-address utility acceptance uses only freshly created fictional keys.
#![cfg(unix)]
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::PathBuf,
    process::Command,
};
fn fixture(name: &str) -> (PathBuf, PathBuf, SpendingKey) {
    let root = std::env::temp_dir().join(format!(
        "uain-owned-addresses-{}-{}",
        std::process::id(),
        name
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let (seed, key) = (1..=255u8)
        .find_map(|n| {
            Option::<SpendingKey>::from(SpendingKey::from_bytes([n; 32])).map(|key| ([n; 32], key))
        })
        .unwrap();
    let path = root.join("fictional-key");
    fs::write(&path, seed).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    (root, path, key)
}
fn tool(path: &std::path::Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_uain-wallet-addresses"))
        .arg(path)
        .output()
        .unwrap()
}
#[test]
fn returns_only_correct_external_and_internal_owned_addresses_without_changing_key() {
    let (root, path, key) = fixture("public");
    let before = fs::read(&path).unwrap();
    let output = tool(&path);
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 2);
    let fvk = FullViewingKey::from(&key);
    assert_eq!(
        value["external"],
        hex::encode(fvk.address_at(0u32, Scope::External).to_raw_address_bytes())
    );
    assert_eq!(
        value["internal"],
        hex::encode(fvk.address_at(0u32, Scope::Internal).to_raw_address_bytes())
    );
    assert_ne!(value["external"], value["internal"]);
    assert!(output.stderr.is_empty());
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn refuses_symlink_loose_permissions_wrong_size_and_directory_without_key_output() {
    let (root, path, _) = fixture("refusals");
    let linked = root.join("link");
    symlink(&path, &linked).unwrap();
    let loose = root.join("loose");
    fs::write(&loose, [1u8; 32]).unwrap();
    fs::set_permissions(&loose, fs::Permissions::from_mode(0o644)).unwrap();
    let large = root.join("large");
    fs::write(&large, [1u8; 33]).unwrap();
    fs::set_permissions(&large, fs::Permissions::from_mode(0o600)).unwrap();
    for invalid in [&linked, &loose, &large, &root] {
        let output = tool(invalid);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains(invalid.to_str().unwrap()));
    }
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn refuses_foreign_owned_key_when_qualification_supplies_one() {
    if let Some(path) = std::env::var_os("UAIN_TEST_FOREIGN_KEY_FILE") {
        use std::os::unix::fs::MetadataExt;
        let path = PathBuf::from(path);
        assert_ne!(fs::metadata(&path).unwrap().uid(), unsafe {
            libc::geteuid()
        });
        let output = tool(&path);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}
#[test]
fn refuses_extra_arguments_or_missing_key_without_private_output() {
    let (root, path, _) = fixture("arguments");
    for args in [vec![], vec![path.to_str().unwrap(), "extra"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_uain-wallet-addresses"))
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
    fs::remove_dir_all(root).unwrap();
}
