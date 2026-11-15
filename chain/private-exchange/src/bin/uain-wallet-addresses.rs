//! Public scope discovery only. No spending/viewing key is printed or written.
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use std::{io, path::Path};
use zeroize::Zeroizing;

#[path = "../wallet_files.rs"]
mod wallet_files;

type Error = Box<dyn std::error::Error>;
fn addresses(path: &Path) -> Result<serde_json::Value, Error> {
    // Reuse exactly the wallet's owned, no-follow, bounded private reader.
    let bytes = wallet_files::read_private(path, 32)?;
    let seed =
        Zeroizing::new(<[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid Orchard key length")
        })?);
    let key = Option::<SpendingKey>::from(SpendingKey::from_bytes(*seed))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid Orchard key"))?;
    let viewing = FullViewingKey::from(&key);
    Ok(serde_json::json!({
        "external": hex::encode(viewing.address_at(0u32, Scope::External).to_raw_address_bytes()),
        "internal": hex::encode(viewing.address_at(0u32, Scope::Internal).to_raw_address_bytes())
    }))
}
fn run() -> Result<(), Error> {
    let mut args = std::env::args_os();
    args.next();
    let path = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "owned key file required"))?;
    if args.next().is_some() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unexpected arguments").into());
    }
    println!("{}", addresses(Path::new(&path))?);
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("Owned wallet address discovery refused.");
        std::process::exit(1);
    }
}
