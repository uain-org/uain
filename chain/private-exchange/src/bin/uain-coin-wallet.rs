//! Member-side wallet. Private keys/addresses/terms are never sent to the chain.
use ed25519_dalek::{Signature, VerifyingKey};
use incrementalmerkletree::{Hashable, Level};
use orchard::{
    builder::{Builder, BundleType},
    circuit::ProvingKey,
    keys::OutgoingViewingKey,
    keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey},
    tree::{Anchor, MerkleHashOrchard, MerklePath},
    value::NoteValue,
    Address,
};
use rand::{rand_core::UnwrapErr, rngs::SysRng, Rng};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, BufRead, Read, Write},
    path::Path,
};
use uain_private_exchange::{effects, encode, signature_hash, version};
use zeroize::Zeroizing;

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
const COIN_POLICY: &str = "verified-bounties-108t-micro-v1";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    chain_id: String,
    expires_height: String,
    licence_revision: String,
    key_file: String,
    commitments: Vec<String>,
    compact_witness: Option<wallet_witness::CompactWitness>,
    note_count: Option<String>,
    expected_root: String,
    source_bundle: Option<String>,
    source_position: Option<u32>,
    member: String,
    amount: String,
    purpose_commitment: String,
    reviewer_public_key: String,
    memo: String,
    review_file: String,
    /// Server-built send (9 Nov 2026): a shield whose paid output goes to this
    /// raw 43-byte Orchard address instead of the member's own wallet. Entry
    /// spends no note, so it needs no member spending key at all: `key_file`
    /// must then be empty and the zero-value padding output goes to a fresh
    /// unreachable address. The member still authorises the debit by signing
    /// the native `coin_shield` command; this tool never sees that key.
    #[serde(default)]
    recipient: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    reviewer: String,
    effects: String,
    purpose_commitment: String,
    class: String,
    expires_height: String,
    licence_revision: String,
    direction: String,
    member: String,
    amount: String,
    signature: String,
}
fn units(text: &str, max: u64, zero: bool) -> Result<u64, E> {
    let value: u64 = text.parse()?;
    if value > max || (!zero && value == 0) || value.to_string() != text {
        return Err(error("canonical bounded decimal string required"));
    }
    Ok(value)
}
fn owner(text: &str) -> Result<Vec<u8>, E> {
    if text.len() != 45
        || !text.starts_with("uain1")
        || text[5..]
            .bytes()
            .any(|b| !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b))
    {
        return Err(error("invalid licensed public owner"));
    }
    Ok(hex::decode(&text[5..])?)
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
fn boundary(direction: &str) -> Result<(), E> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut line = Zeroizing::new(String::new());
    if (&mut input)
        .take(80 * 1024 * 1024 + 1)
        .read_line(&mut line)?
        == 0
        || line.len() > 80 * 1024 * 1024
    {
        return Err(error("bounded private intent required"));
    }
    let intent: Intent = serde_json::from_str(&line)?;
    line.clear();
    let amount = units(&intent.amount, i64::MAX as u64, false)?;
    let expiry = units(&intent.expires_height, i64::MAX as u64, false)?;
    let revision = units(&intent.licence_revision, u64::MAX, true)?;
    let member = owner(&intent.member)?;
    if intent.chain_id.is_empty()
        || intent.chain_id.len() > 128
        || intent.memo.len() > 512
        || intent.commitments.len() > 1048576
    {
        return Err(error("invalid private Coin intent"));
    }
    let recipient = match &intent.recipient {
        None => None,
        Some(text) => {
            if direction != "shield" || !intent.key_file.is_empty() {
                return Err(error("a recipient shield takes no member key"));
            }
            let raw: [u8; 43] = hex::decode(text)?
                .try_into()
                .map_err(|_| error("recipient must be a 43-byte raw Orchard address"))?;
            Some(
                Option::<Address>::from(Address::from_raw_address_bytes(&raw))
                    .ok_or_else(|| error("invalid recipient Orchard address"))?,
            )
        }
    };
    let sk = if recipient.is_some() {
        fresh_key()
    } else {
        key(Path::new(&intent.key_file))?
    };
    let fvk = FullViewingKey::from(&sk);
    let root = bytes32(&intent.expected_root)?;
    if intent.note_count.is_some() && !intent.commitments.is_empty()
        || intent.compact_witness.is_some() && intent.note_count.is_none()
    {
        return Err(error("ambiguous compact witness"));
    }
    let anchor = if let Some(count) = &intent.note_count {
        wallet_witness::count(count)?;
        Option::from(Anchor::from_bytes(root)).ok_or_else(|| error("invalid finalized root"))?
    } else if intent.commitments.is_empty() {
        Anchor::empty_tree()
    } else {
        let leaf = Option::<orchard::note::ExtractedNoteCommitment>::from(
            orchard::note::ExtractedNoteCommitment::from_bytes(&bytes32(&intent.commitments[0])?),
        )
        .ok_or_else(|| error("invalid first commitment"))?;
        witness(&intent.commitments, 0)?.root(leaf)
    };
    if anchor.to_bytes() != root {
        return Err(error("witness differs from finalized pool root"));
    }
    let mut rng = UnwrapErr(SysRng);
    let mut ovk = Zeroizing::new([0; 32]);
    rng.fill_bytes(ovk.as_mut());
    let one_time = OutgoingViewingKey::from(*ovk);
    let mut builder = Builder::new(
        BundleType::DEFAULT,
        version(),
        version().default_flags(),
        anchor,
    )?;
    let output = if direction == "shield" {
        if intent.source_bundle.is_some()
            || intent.source_position.is_some()
            || intent.compact_witness.is_some()
        {
            return Err(error("entry must not spend an existing note"));
        }
        amount
    } else {
        let raw = intent
            .source_bundle
            .as_ref()
            .ok_or_else(|| error("exit needs an authenticated source"))?;
        if raw.len() != uain_private_exchange::wire_size() * 2 {
            return Err(error("invalid source wire length"));
        }
        let source = uain_private_exchange::decode(&hex::decode(raw)?)
            .map_err(|_| error("invalid source bundle"))?;
        let position = intent
            .source_position
            .ok_or_else(|| error("source position required"))?;
        let cmx = bytes32(match &intent.compact_witness {
            Some(w) => &w.commitment,
            None => intent
                .commitments
                .get(position as usize)
                .ok_or_else(|| error("source position missing"))?,
        })?;
        let (_, _, note, _, _) = source
            .decrypt_outputs_with_keys(&[fvk.to_ivk(Scope::External), fvk.to_ivk(Scope::Internal)])
            .into_iter()
            .find(|(_, _, note, _, _)| {
                orchard::note::ExtractedNoteCommitment::from(note.commitment()).to_bytes() == cmx
            })
            .ok_or_else(|| error("source note is not owned"))?;
        let value = note.value().inner();
        if value < amount {
            return Err(error("insufficient owned note value"));
        }
        let path = match &intent.compact_witness {
            Some(w) => wallet_witness::path(
                w,
                position,
                intent
                    .note_count
                    .as_ref()
                    .ok_or_else(|| error("missing note count"))?,
            )?,
            None => {
                if intent.note_count.is_some() {
                    return Err(error("compact exit needs a membership path"));
                }
                witness(&intent.commitments, position)?
            }
        };
        if path.root(note.commitment().into()).to_bytes() != root {
            return Err(error("source root mismatch"));
        }
        builder.add_spend(fvk.clone(), note, path)?;
        value - amount
    };
    let mut memo = [0; 512];
    memo[..intent.memo.len()].copy_from_slice(intent.memo.as_bytes());
    let self_address = fvk.address_at(0u32, Scope::Internal);
    builder.add_output(
        Some(one_time.clone()),
        recipient.unwrap_or(self_address),
        NoteValue::from_raw(output),
        memo,
    )?;
    builder.add_output(
        Some(one_time),
        self_address,
        NoteValue::from_raw(0),
        [0; 512],
    )?;
    let (bundle, _) = builder
        .build::<i64>(&mut rng)?
        .ok_or_else(|| error("empty boundary"))?;
    let expected = if direction == "shield" {
        -(amount as i64)
    } else {
        amount as i64
    };
    if *bundle.value_balance() != expected {
        return Err(error("boundary does not conserve Coin"));
    }
    let effect = effects(&bundle).map_err(|_| error("invalid effects"))?;
    let purpose = bytes32(&intent.purpose_commitment)?;
    let reviewer = bytes32(&intent.reviewer_public_key)?;
    if Sha256::digest(reviewer)[..20] == member {
        return Err(error("independent reviewer required"));
    }
    let request = serde_json::json!({"version":1,"effects":hex::encode(effect),"purpose_commitment":hex::encode(purpose),"expires_height":intent.expires_height,"licence_revision":intent.licence_revision,"direction":direction,"member":intent.member,"amount":intent.amount});
    let packet = serde_json::json!({"request":request,"chain_id":intent.chain_id,"reviewer_public_key":intent.reviewer_public_key,"effects":hex::encode(effect),"effects_wire_hex":hex::encode(uain_private_exchange::encode_for_review(&bundle).map_err(|_|error("review encoding failed"))?),"one_time_viewing_key":hex::encode(*ovk)});
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&intent.review_file)?;
    let bytes = Zeroizing::new(serde_json::to_vec(&packet)?);
    file.write_all(bytes.as_ref())?;
    file.sync_all()?;
    println!("{}", request);
    io::stdout().flush()?;
    if (&mut input).take(4097).read_line(&mut line)? == 0 || line.len() > 4096 {
        return Err(error("bounded reviewer approval required"));
    }
    let approval: Approval = serde_json::from_str(&line)?;
    let reviewer_member = format!("uain1{}", hex::encode(&Sha256::digest(reviewer)[..20]));
    if approval.reviewer != reviewer_member
        || approval.effects != hex::encode(effect)
        || approval.purpose_commitment != hex::encode(purpose)
        || approval.expires_height != intent.expires_height
        || approval.licence_revision != intent.licence_revision
        || approval.member != intent.member
        || approval.direction != direction
        || approval.amount != intent.amount
    {
        return Err(error("approval differs from owner boundary"));
    }
    let cls = match approval.class.as_str() {
        "benevolent" => 1,
        "neutral" => 2,
        _ => return Err(error("missing ethical review")),
    };
    let chain: [u8; 32] = Sha256::digest(intent.chain_id.as_bytes()).into();
    let mut review = b"UAIN/coin-boundary/approval/v1\0".to_vec();
    review.extend(Sha256::digest(COIN_POLICY.as_bytes()));
    review.extend(chain);
    review.extend(expiry.to_be_bytes());
    review.extend(revision.to_be_bytes());
    review.extend(effect);
    review.extend(purpose);
    review.extend([cls, 1]);
    review.extend(reviewer);
    review.push(if direction == "shield" { 1 } else { 2 });
    review.extend(member);
    review.extend(amount.to_be_bytes());
    let signature = Signature::from_slice(&hex::decode(approval.signature)?)?;
    VerifyingKey::from_bytes(&reviewer)?.verify_strict(&review, &signature)?;
    review.extend(signature.to_bytes());
    let approval_hash = Sha256::digest(review).into();
    let hash = signature_hash(&chain, expiry, &approval_hash, &effect);
    let pk = ProvingKey::build(version().circuit_version());
    let keys = if direction == "exit" {
        vec![SpendAuthorizingKey::from(&sk)]
    } else {
        vec![]
    };
    let bundle = bundle
        .create_proof(&pk, &mut rng)?
        .apply_signatures(&mut rng, hash, &keys)?;
    let wire = encode(&bundle).map_err(|_| error("encoding failed"))?;
    uain_private_exchange::verify(&wire, &chain, expiry, &approval_hash)
        .map_err(|_| error("boundary self-verification failed"))?;
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
    if hex::encode(effects(&bundle).map_err(|_| error("invalid review commitment"))?)
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
        serde_json::json!({"effects":text("effects")?,"value_balance":bundle.value_balance().to_string(),"outputs":outputs})
    );
    Ok(())
}
fn fresh_key() -> SpendingKey {
    let mut rng = UnwrapErr(SysRng);
    loop {
        let mut seed = Zeroizing::new([0; 32]);
        rng.fill_bytes(seed.as_mut());
        if let Some(key) = Option::<SpendingKey>::from(SpendingKey::from_bytes(*seed)) {
            break key;
        }
    }
}
/// Public receiving data for a member-held key: the raw full viewing key and
/// the default external address. Neither is a spending secret.
fn viewing_key(path: &Path) -> Result<(), E> {
    let fvk = FullViewingKey::from(&key(path)?);
    let address = fvk.address_at(0u32, Scope::External);
    println!(
        "{}",
        serde_json::json!({"full_viewing_key":hex::encode(fvk.to_bytes()),"address":hex::encode(address.to_raw_address_bytes())})
    );
    Ok(())
}
/// The default external address of a raw Orchard full viewing key read from
/// stdin as `{"full_viewing_key":"<192 hex>"}`. Lets a server derive the
/// address a member receives at without ever seeing the spending key.
fn address_from_fvk() -> Result<(), E> {
    let mut text = String::new();
    io::stdin().take(4096).read_to_string(&mut text)?;
    let value: serde_json::Value = serde_json::from_str(text.trim_end())?;
    let object = value
        .as_object()
        .filter(|o| o.len() == 1)
        .ok_or_else(|| error("full_viewing_key object required"))?;
    let encoded = object
        .get("full_viewing_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| error("full_viewing_key required"))?;
    let raw = hex::decode(encoded).map_err(|_| error("invalid full viewing key"))?;
    if hex::encode(&raw) != encoded {
        return Err(error("canonical lowercase full viewing key required"));
    }
    let bytes: [u8; 96] = raw
        .try_into()
        .map_err(|_| error("full viewing key must be 96 bytes"))?;
    let fvk = FullViewingKey::from_bytes(&bytes)
        .ok_or_else(|| error("invalid Orchard full viewing key"))?;
    let address = fvk.address_at(0u32, Scope::External);
    println!(
        "{}",
        serde_json::json!({"address":hex::encode(address.to_raw_address_bytes())})
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
 },Some("shield")=>boundary("shield"),Some("exit")=>boundary("exit"),Some("inspect-review")=>inspect(Path::new(args.get(2).ok_or_else(||error("private review packet required"))?)),Some("viewing-key")=>viewing_key(Path::new(args.get(2).ok_or_else(||error("viewing-key requires a private key file"))?)),Some("address-from-fvk")=>address_from_fvk(),_=>Err(error("usage: uain-coin-wallet keygen <new-private-file> | viewing-key <private-file> | address-from-fvk | shield | exit (two-line private stdin protocol)"))
 }
}
fn main() {
    if let Err(_) = run() {
        eprintln!("Coin wallet operation refused; check private input, key permissions, witness and approval.");
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
