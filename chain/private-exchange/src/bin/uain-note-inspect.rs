//! Holder-local output decryption. The caller must independently authenticate
//! the exact persisted ciphertext; this utility grants no chain authority.
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use serde::Deserialize;
use std::{
    io::{self, Read},
    path::Path,
};
use zeroize::Zeroizing;
#[path = "../wallet_files.rs"]
mod wallet_files;
type Error = Box<dyn std::error::Error>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    effects: String,
    bundle_hex: String,
}
fn invalid() -> Error {
    io::Error::new(io::ErrorKind::InvalidInput, "owned note inspection refused").into()
}
fn run() -> Result<(), Error> {
    let mut args = std::env::args_os();
    args.next();
    let path = args.next().ok_or_else(invalid)?;
    if args.next().is_some() {
        return Err(invalid());
    }
    let bytes = wallet_files::read_private(Path::new(&path), 32)?;
    let seed = Zeroizing::new(<[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| invalid())?);
    let key = Option::<SpendingKey>::from(SpendingKey::from_bytes(*seed)).ok_or_else(invalid)?;
    let mut raw = Vec::new();
    io::stdin().take(65537).read_to_end(&mut raw)?;
    if raw.len() > 65536 {
        return Err(invalid());
    }
    let input: Input = serde_json::from_slice(&raw)?;
    let lower_hex = |value: &str| {
        value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    };
    if input.effects.len() != 64
        || !lower_hex(&input.effects)
        || input.bundle_hex.len() != uain_private_exchange::wire_size() * 2
        || !lower_hex(&input.bundle_hex)
    {
        return Err(invalid());
    }
    let bundle =
        uain_private_exchange::decode(&hex::decode(&input.bundle_hex)?).map_err(|_| invalid())?;
    if hex::encode(uain_private_exchange::effects(&bundle).map_err(|_| invalid())?) != input.effects
    {
        return Err(invalid());
    }
    let viewing = FullViewingKey::from(&key);
    let outputs:Vec<_>=bundle.decrypt_outputs_with_keys(&[viewing.to_ivk(Scope::External),viewing.to_ivk(Scope::Internal)]).into_iter().map(|(position,_,note,address,_)|serde_json::json!({"address":hex::encode(address.to_raw_address_bytes()),"amount":note.value().inner().to_string(),"position":position})).collect();
    println!(
        "{}",
        serde_json::json!({"effects":input.effects,"positionScope":"bundle-action","outputs":outputs})
    );
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("Owned note inspection refused.");
        std::process::exit(1);
    }
}
