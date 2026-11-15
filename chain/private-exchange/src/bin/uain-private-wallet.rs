//! Member-side wallet. Private keys/addresses/terms are never sent to the chain.
use ed25519_dalek::{Signature, VerifyingKey};
use incrementalmerkletree::{Hashable, Level};
use orchard::{
    builder::{Builder, BundleType},
    circuit::ProvingKey,
    keys::OutgoingViewingKey,
    keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey},
    tree::{MerkleHashOrchard, MerklePath},
    value::NoteValue,
    Address,
};
use rand::{rand_core::UnwrapErr, rngs::SysRng, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, BufRead, Read, Write},
    path::Path,
};
use uain_private_exchange::{effects, encode, signature_hash, version};
use zeroize::Zeroizing;

#[path = "../wallet_units.rs"]
mod wallet_units;

#[path = "../wallet_witness.rs"]
mod wallet_witness;

#[path = "../wallet_files.rs"]
mod wallet_files;

type E = Box<dyn std::error::Error>;
fn error(s: &str) -> E {
    io::Error::new(io::ErrorKind::InvalidInput, s).into()
}
fn key(path: &Path) -> Result<SpendingKey, E> {
    let bytes = wallet_files::read_private(path, 32)?;
    if bytes.len() != 32 {
        return Err(error("wallet key must contain 32 raw bytes"));
    }
    let seed = Zeroizing::new(
        <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| error("invalid key length"))?,
    );
    Option::from(SpendingKey::from_bytes(*seed))
        .ok_or_else(|| error("invalid Orchard spending key"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    chain_id: String,
    #[serde(deserialize_with = "wallet_units::deserialize")]
    expires_height: u64,
    licence_revision: String,
    key_file: String,
    // Public chain commitments and encrypted bundles, downloaded/verified by the client.
    commitments: Vec<String>,
    compact_witness: Option<wallet_witness::CompactWitness>,
    note_count: Option<String>,
    expected_root: String,
    source_bundle: String,
    source_position: u32,
    recipient: String,
    #[serde(deserialize_with = "wallet_units::deserialize")]
    amount: u64,
    purpose_commitment: String,
    reviewer_public_key: String,
    memo: String,
    review_file: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    effects: String,
    purpose_commitment: String,
    class: String,
    #[serde(deserialize_with = "wallet_units::deserialize")]
    expires_height: u64,
    licence_revision: String,
    signature: String,
}
#[derive(Serialize)]
struct Request {
    effects: String,
    purpose_commitment: String,
    #[serde(serialize_with = "wallet_units::serialize")]
    expires_height: u64,
    licence_revision: String,
}
fn bytes32(s: &str) -> Result<[u8; 32], E> {
    hex::decode(s)?
        .try_into()
        .map_err(|_| error("expected 32-byte hex"))
}
fn witness(commitments: &[String], position: u32) -> Result<MerklePath, E> {
    if commitments.is_empty()
        || commitments.len() > 1048576
        || position as usize >= commitments.len()
    {
        return Err(error("invalid or oversized local witness input"));
    }
    let mut nodes: Vec<_> = commitments
        .iter()
        .map(|s| {
            bytes32(s).and_then(|b| {
                Option::from(MerkleHashOrchard::from_bytes(&b))
                    .ok_or_else(|| error("invalid commitment"))
            })
        })
        .collect::<Result<_, _>>()?;
    let mut path = [MerkleHashOrchard::empty_leaf(); 32];
    let mut index = position as usize;
    for (level, sibling) in path.iter_mut().enumerate() {
        *sibling = nodes
            .get(index ^ 1)
            .copied()
            .unwrap_or_else(|| MerkleHashOrchard::empty_root(Level::from(level as u8)));
        nodes = nodes
            .chunks(2)
            .map(|n| {
                MerkleHashOrchard::combine(
                    Level::from(level as u8),
                    &n[0],
                    n.get(1)
                        .unwrap_or(&MerkleHashOrchard::empty_root(Level::from(level as u8))),
                )
            })
            .collect();
        index /= 2;
    }
    Ok(MerklePath::from_parts(position, path))
}
fn pay() -> Result<(), E> {
    // Two lines on private stdin: private intent, then the reviewer's signed approval.
    // The only interim stdout is the public commitment request. Keep stdout private until relay submission.
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut line = Zeroizing::new(String::new());
    if (&mut input)
        .take(80 * 1024 * 1024 + 1)
        .read_line(&mut line)?
        == 0
        || line.len() > 80 * 1024 * 1024
    {
        return Err(error("missing/oversized private intent"));
    }
    let intent: Intent = serde_json::from_str(&line)?;
    line.clear();
    if intent.chain_id.is_empty()
        || intent.chain_id.len() > 128
        || intent.expires_height == 0
        || intent.amount == 0
        || intent.memo.len() > 512
    {
        return Err(error("invalid private intent"));
    }
    let licence_revision: u64 = intent.licence_revision.parse()?;
    if licence_revision.to_string() != intent.licence_revision
        || intent.expires_height > i64::MAX as u64
        || intent.amount > i64::MAX as u64
    {
        return Err(error("canonical bounded private units required"));
    }
    let sk = key(Path::new(&intent.key_file))?;
    let fvk = FullViewingKey::from(&sk);
    if intent.source_bundle.len() != uain_private_exchange::wire_size() * 2
        || intent.commitments.len() > 1048576
    {
        return Err(error("oversized private witness input"));
    }
    let source = uain_private_exchange::decode(&hex::decode(&intent.source_bundle)?)
        .map_err(|_| error("invalid source bundle"))?;
    let owned = source
        .decrypt_outputs_with_keys(&[fvk.to_ivk(Scope::External), fvk.to_ivk(Scope::Internal)]);
    // A caller must identify the precise source action via its global commitment position.
    if intent.compact_witness.is_some() && !intent.commitments.is_empty()
        || intent.compact_witness.is_some() != intent.note_count.is_some()
    {
        return Err(error("ambiguous compact witness"));
    }
    let cmx = bytes32(match &intent.compact_witness {
        Some(w) => &w.commitment,
        None => intent
            .commitments
            .get(intent.source_position as usize)
            .ok_or_else(|| error("source position missing"))?,
    })?;
    let (_, _, note, _, _) = owned
        .into_iter()
        .find(|(_, _, note, _, _)| {
            orchard::note::ExtractedNoteCommitment::from(note.commitment()).to_bytes() == cmx
        })
        .ok_or_else(|| error("source note not owned by this wallet"))?;
    let value = note.value().inner();
    if value < intent.amount {
        return Err(error("insufficient shielded note value"));
    }
    let path = match &intent.compact_witness {
        Some(w) => wallet_witness::path(
            w,
            intent.source_position,
            intent
                .note_count
                .as_ref()
                .ok_or_else(|| error("missing note count"))?,
        )?,
        None => witness(&intent.commitments, intent.source_position)?,
    };
    let anchor = path.root(note.commitment().into());
    if anchor.to_bytes() != bytes32(&intent.expected_root)? {
        return Err(error(
            "witness does not match proof-verified finalized root",
        ));
    }
    let recipient_bytes: [u8; 43] = hex::decode(&intent.recipient)?
        .try_into()
        .map_err(|_| error("invalid Orchard recipient"))?;
    let recipient = Option::from(Address::from_raw_address_bytes(&recipient_bytes))
        .ok_or_else(|| error("invalid Orchard recipient"))?;
    let mut rng = UnwrapErr(SysRng);
    let mut ovk = Zeroizing::new([0u8; 32]);
    rng.fill_bytes(ovk.as_mut());
    let one_time_ovk = OutgoingViewingKey::from(*ovk);
    let mut builder = Builder::new(
        BundleType::DEFAULT,
        version(),
        version().default_flags(),
        anchor,
    )?;
    builder.add_spend(fvk.clone(), note, path)?;
    let mut memo = [0; 512];
    memo[..intent.memo.len()].copy_from_slice(intent.memo.as_bytes());
    builder.add_output(
        Some(one_time_ovk.clone()),
        recipient,
        NoteValue::from_raw(intent.amount),
        memo,
    )?;
    builder.add_output(
        Some(one_time_ovk),
        fvk.address_at(0u32, Scope::Internal),
        NoteValue::from_raw(value - intent.amount),
        [0; 512],
    )?;
    let (bundle, _) = builder
        .build::<i64>(&mut rng)?
        .ok_or_else(|| error("empty payment"))?;
    if *bundle.value_balance() != 0 {
        return Err(error("private payment must conserve shielded value"));
    }
    let effects = effects(&bundle).map_err(|_| error("invalid payment effects"))?;
    let purpose = bytes32(&intent.purpose_commitment)?;
    let packet = serde_json::json!({"version":1,"effects":hex::encode(effects),"purpose_commitment":hex::encode(purpose),"expires_height":intent.expires_height.to_string(),"licence_revision":intent.licence_revision,"chain_id":intent.chain_id,"reviewer_public_key":intent.reviewer_public_key,"effects_wire_hex":hex::encode(uain_private_exchange::encode_for_review(&bundle).map_err(|_|error("review effects encoding failed"))?),"one_time_viewing_key":hex::encode(*ovk)});
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&intent.review_file)?;
    let packet_bytes = Zeroizing::new(serde_json::to_vec(&packet)?);
    file.write_all(packet_bytes.as_ref())?;
    file.sync_all()?;
    println!(
        "{}",
        serde_json::to_string(&Request {
            effects: hex::encode(effects),
            purpose_commitment: hex::encode(purpose),
            expires_height: intent.expires_height,
            licence_revision: intent.licence_revision.clone()
        })?
    );
    io::stdout().flush()?;
    if (&mut input).take(4097).read_line(&mut line)? == 0 || line.len() > 4096 {
        return Err(error("missing signed private approval"));
    }
    let approval: Approval = serde_json::from_str(&line)?;
    if approval.effects != hex::encode(effects)
        || approval.purpose_commitment != hex::encode(purpose)
        || approval.expires_height != intent.expires_height
        || approval.licence_revision != intent.licence_revision
    {
        return Err(error("review is for different payment"));
    }
    let class = match approval.class.as_str() {
        "benevolent" => 1,
        "neutral" => 2,
        _ => return Err(error("malevolent or missing review")),
    };
    let reviewer = bytes32(&intent.reviewer_public_key)?;
    let chain: [u8; 32] = Sha256::digest(intent.chain_id.as_bytes()).into();
    let mut review = b"UAIN/private-exchange/approval/v1\0".to_vec();
    review.extend(chain);
    review.extend(intent.expires_height.to_be_bytes());
    review.extend(licence_revision.to_be_bytes());
    review.extend(effects);
    review.extend(purpose);
    review.extend([class, 1]);
    review.extend(reviewer);
    let signature = Signature::from_slice(&hex::decode(approval.signature)?)?;
    VerifyingKey::from_bytes(&reviewer)?.verify_strict(&review, &signature)?;
    review.extend(signature.to_bytes());
    let approval_hash = Sha256::digest(review).into();
    let hash = signature_hash(&chain, intent.expires_height, &approval_hash, &effects);
    let pk = ProvingKey::build(version().circuit_version());
    let bundle = bundle.create_proof(&pk, &mut rng)?.apply_signatures(
        &mut rng,
        hash,
        &[SpendAuthorizingKey::from(&sk)],
    )?;
    let wire = encode(&bundle).map_err(|_| error("private bundle encoding failed"))?;
    uain_private_exchange::verify(&wire, &chain, intent.expires_height, &approval_hash)
        .map_err(|_| error("self-verification failed"))?;
    println!("{}", serde_json::json!({"bundle_hex":hex::encode(wire)}));
    Ok(())
}
fn inspect(path: &Path) -> Result<(), E> {
    let bytes = wallet_files::read_private(path, 256 * 1024)?;
    let packet: serde_json::Value = serde_json::from_slice(bytes.as_ref())?;
    let text = |name: &str| -> Result<&str, E> {
        packet
            .get(name)
            .and_then(|v| v.as_str())
            .ok_or_else(|| error("invalid review packet"))
    };
    let bundle = uain_private_exchange::decode(&hex::decode(text("effects_wire_hex")?)?)
        .map_err(|_| error("invalid review effects"))?;
    if *bundle.value_balance() != 0
        || hex::encode(effects(&bundle).map_err(|_| error("invalid review commitment"))?)
            != text("effects")?
    {
        return Err(error("private review commitment mismatch"));
    }
    let ovk = Zeroizing::new(bytes32(text("one_time_viewing_key")?)?);
    let notes = bundle.recover_outputs_with_ovks(&[OutgoingViewingKey::from(*ovk)]);
    if notes.len() != 2 {
        return Err(error("reviewer cannot recover both payment outputs"));
    }
    let outputs:Vec<_>=notes.into_iter().map(|(position,_,note,address,memo)|serde_json::json!({"position":position,"address":hex::encode(address.to_raw_address_bytes()),"amount":note.value().inner().to_string(),"memo_hex":hex::encode(memo)})).collect();
    println!(
        "{}",
        serde_json::json!({"effects":text("effects")?,"outputs":outputs})
    );
    Ok(())
}
fn run() -> Result<(), E> {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str){
 Some("keygen")=>{
  let path=Path::new(args.get(2).ok_or_else(||error("keygen requires a new private key file"))?);
  let mut rng=UnwrapErr(SysRng);let sk=loop{let mut seed=Zeroizing::new([0;32]);rng.fill_bytes(seed.as_mut());if let Some(key)=Option::<SpendingKey>::from(SpendingKey::from_bytes(*seed)){break key}};
  let mut options=fs::OpenOptions::new();options.create_new(true).write(true);
  #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
  let mut file=options.open(path)?;let seed=Zeroizing::new(*sk.to_bytes());file.write_all(seed.as_ref())?;file.sync_all()?;
  let address=FullViewingKey::from(&sk).address_at(0u32,Scope::External);println!("{}",serde_json::json!({"address":hex::encode(address.to_raw_address_bytes())}));Ok(())
 },Some("pay")=>pay(),Some("inspect-review")=>inspect(Path::new(args.get(2).ok_or_else(||error("private review packet required"))?)),_=>Err(error("usage: uain-private-wallet keygen <new-private-file> | pay (two-line private stdin protocol)"))
 }
}
fn main() {
    if let Err(_) = run() {
        eprintln!("Private wallet operation refused; check private input, key permissions, witness and approval.");
        std::process::exit(1)
    }
}

#[cfg(all(test, unix))]
mod private_file_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn refuses_symlinked_spending_key() {
        let root = std::env::temp_dir().join(format!(
            "uain-wallet-key-{}-{}",
            std::process::id(),
            module_path!()
        ));
        fs::create_dir(&root).unwrap();
        let file = root.join("key");
        let link = root.join("link");
        fs::write(&file, [1u8; 32]).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&file, &link).unwrap();
        let result = key(&link);
        fs::remove_dir_all(root).unwrap();
        assert!(
            result.is_err(),
            "a symlink must not confer access to a spending key"
        );
    }

    #[test]
    fn refuses_foreign_owned_spending_key_when_root() {
        // Capability-free CI receives a real foreign-owned fictional fixture
        // from Docker before tests start. Do not grant CAP_CHOWN to tested code.
        if let Some(file) = std::env::var_os("UAIN_TEST_FOREIGN_KEY_FILE") {
            use std::os::unix::fs::MetadataExt;
            let file = Path::new(&file);
            let metadata = fs::metadata(file).unwrap();
            assert_eq!(metadata.uid(), 65534);
            assert_ne!(metadata.uid(), unsafe { libc::geteuid() });
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            assert_eq!(metadata.len(), 32);
            assert_eq!(
                wallet_files::read_private(file, 32).unwrap_err().kind(),
                std::io::ErrorKind::PermissionDenied
            );
            assert!(key(file).is_err());
            return;
        }
        // Root-only qualification covers the file-owner boundary. Ordinary
        // unprivileged cargo runs cannot manufacture another user's file.
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "uain-wallet-owner-{}-{}",
            std::process::id(),
            module_path!()
        ));
        fs::create_dir(&root).unwrap();
        let file = root.join("key");
        fs::write(&file, [1u8; 32]).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let path = std::ffi::CString::new(file.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::chown(path.as_ptr(), 65534, 65534) }, 0);
        let result = key(&file);
        fs::remove_dir_all(root).unwrap();
        assert!(
            result.is_err(),
            "a private file owned by another user must be refused"
        );
    }
}
