//! UAIN's bounded Orchard adapter. No network, clock, RNG or wallet keys in verification.
//! The circuit and all point/proof parsing come from pinned upstream Orchard.
use incrementalmerkletree::{Hashable, Level};
use nonempty::NonEmpty;
use orchard::{
    bundle::{Authorization, Authorized, Bundle, BundleVersion, TxVersion},
    circuit::VerifyingKey,
    note::{ExtractedNoteCommitment, Nullifier, TransmittedNoteCiphertext},
    note_encryption::NoteBytesData,
    primitives::redpallas::{self, Binding, SpendAuth},
    tree::{Anchor, MerkleHashOrchard},
    value::ValueCommitment,
    Action, Proof,
};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub const ACTIONS: usize = 2;
const MAGIC: &[u8; 5] = b"UOTC1";
const ACTION_BYTES: usize = 32 * 5 + 580 + 80 + 64;
static VK: OnceLock<VerifyingKey> = OnceLock::new();
pub type AuthorizedBundle = Bundle<Authorized, i64>;
pub fn version() -> BundleVersion {
    BundleVersion::orchard_v2()
}
pub fn wire_size() -> usize {
    5 + 8 + 32 + ACTIONS * ACTION_BYTES + Proof::expected_proof_size(ACTIONS) + 64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Encoding,
    Authorization,
    Proof,
}
struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let end = self.position.checked_add(N).ok_or(Error::Encoding)?;
        let out = self
            .bytes
            .get(self.position..end)
            .ok_or(Error::Encoding)?
            .try_into()
            .map_err(|_| Error::Encoding)?;
        self.position = end;
        Ok(out)
    }
}
pub fn decode(bytes: &[u8]) -> Result<AuthorizedBundle, Error> {
    if bytes.len() != wire_size() {
        return Err(Error::Encoding);
    }
    let mut r = Reader { bytes, position: 0 };
    if &r.take::<5>()? != MAGIC {
        return Err(Error::Encoding);
    }
    let value_balance = i64::from_le_bytes(r.take()?);
    // The asset adapter imposes a tighter bound; never accept i64::MIN (negation overflow).
    if value_balance == i64::MIN {
        return Err(Error::Encoding);
    }
    let anchor = Option::from(Anchor::from_bytes(r.take()?)).ok_or(Error::Encoding)?;
    let mut actions = Vec::with_capacity(ACTIONS);
    for _ in 0..ACTIONS {
        let cv = Option::from(ValueCommitment::from_bytes(&r.take()?)).ok_or(Error::Encoding)?;
        let nf = Option::from(Nullifier::from_bytes(&r.take()?)).ok_or(Error::Encoding)?;
        let rk = redpallas::VerificationKey::<SpendAuth>::try_from(r.take::<32>()?)
            .map_err(|_| Error::Encoding)?;
        let cmx =
            Option::from(ExtractedNoteCommitment::from_bytes(&r.take()?)).ok_or(Error::Encoding)?;
        let encrypted_note = TransmittedNoteCiphertext {
            epk_bytes: r.take()?,
            enc_ciphertext: NoteBytesData(r.take()?),
            out_ciphertext: r.take()?,
        };
        let signature = redpallas::Signature::<SpendAuth>::from(r.take::<64>()?);
        actions.push(
            Action::from_parts(nf, rk, cmx, encrypted_note, cv, signature)
                .map_err(|_| Error::Encoding)?,
        );
    }
    let proof_end = r.position + Proof::expected_proof_size(ACTIONS);
    let proof = Proof::new(bytes[r.position..proof_end].to_vec());
    r.position = proof_end;
    let auth = Authorized::from_parts(
        proof,
        redpallas::Signature::<Binding>::from(r.take::<64>()?),
    );
    Bundle::try_from_parts(
        NonEmpty::from_vec(actions).ok_or(Error::Encoding)?,
        version().default_flags(),
        value_balance,
        anchor,
        auth,
        version(),
    )
    .map_err(|_| Error::Encoding)
}
pub fn encode(bundle: &AuthorizedBundle) -> Result<Vec<u8>, Error> {
    if bundle.actions().len() != ACTIONS
        || bundle.bundle_version() != version()
        || bundle.flags() != &version().default_flags()
    {
        return Err(Error::Encoding);
    }
    let mut out = Vec::with_capacity(wire_size());
    out.extend(MAGIC);
    out.extend(bundle.value_balance().to_le_bytes());
    out.extend(bundle.anchor().to_bytes());
    for action in bundle.actions().iter() {
        out.extend(action.cv_net().to_bytes());
        out.extend(action.nullifier().to_bytes());
        out.extend(<[u8; 32]>::from(action.rk()));
        out.extend(action.cmx().to_bytes());
        out.extend(action.encrypted_note().epk_bytes);
        out.extend(action.encrypted_note().enc_ciphertext.0);
        out.extend(action.encrypted_note().out_ciphertext);
        out.extend(<[u8; 64]>::from(action.authorization()));
    }
    out.extend(bundle.authorization().proof().as_ref());
    out.extend(<[u8; 64]>::from(bundle.authorization().binding_signature()));
    if out.len() != wire_size() {
        return Err(Error::Encoding);
    }
    Ok(out)
}
/// Effects include ciphertexts, anchor, note/value commitments and nullifiers, excluding signatures/proof.
pub fn effects<T: Authorization>(bundle: &Bundle<T, i64>) -> Result<[u8; 32], Error> {
    let c = bundle
        .commitment(TxVersion::V5)
        .map_err(|_| Error::Encoding)?;
    Ok(c.0.as_bytes().try_into().map_err(|_| Error::Encoding)?)
}
/// Fixed byte framing avoids JSON canonicalization and binds the application/epoch, expiry and approval.
pub fn signature_hash(
    chain: &[u8; 32],
    expires: u64,
    approval: &[u8; 32],
    effects: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"UAIN/private-exchange/sighash/v1\0");
    h.update(chain);
    h.update(expires.to_be_bytes());
    h.update(approval);
    h.update(effects);
    h.finalize().into()
}
pub fn verify(
    bytes: &[u8],
    chain: &[u8; 32],
    expires: u64,
    approval: &[u8; 32],
) -> Result<AuthorizedBundle, Error> {
    let bundle = decode(bytes)?;
    let sighash = signature_hash(chain, expires, approval, &effects(&bundle)?);
    for action in bundle.actions().iter() {
        action
            .rk()
            .verify(&sighash, action.authorization())
            .map_err(|_| Error::Authorization)?;
    }
    bundle
        .binding_validating_key()
        .verify(&sighash, bundle.authorization().binding_signature())
        .map_err(|_| Error::Authorization)?;
    let vk = VK.get_or_init(|| VerifyingKey::build(version().circuit_version()));
    bundle.verify_proof(vk).map_err(|_| Error::Proof)?;
    Ok(bundle)
}
pub fn combine(level: u8, left: [u8; 32], right: [u8; 32]) -> Result<[u8; 32], Error> {
    if level >= 32 {
        return Err(Error::Encoding);
    }
    let l = Option::from(MerkleHashOrchard::from_bytes(&left)).ok_or(Error::Encoding)?;
    let r = Option::from(MerkleHashOrchard::from_bytes(&right)).ok_or(Error::Encoding)?;
    Ok(MerkleHashOrchard::combine(Level::from(level), &l, &r).to_bytes())
}
pub fn empty(level: u8) -> Result<[u8; 32], Error> {
    if level > 32 {
        return Err(Error::Encoding);
    }
    Ok(MerkleHashOrchard::empty_root(Level::from(level)).to_bytes())
}

// FFI takes caller-owned fixed buffers. No allocation ownership crosses the boundary.
// Return 0 only for full success; Rust panics are caught and fail closed.
#[no_mangle]
pub unsafe extern "C" fn uain_orchard_verify(
    data: *const u8,
    len: usize,
    hash: *const u8,
    out: *mut u8,
) -> i32 {
    if data.is_null() || hash.is_null() || out.is_null() || len != wire_size() {
        return 1;
    }
    let result = std::panic::catch_unwind(|| {
        let context = std::slice::from_raw_parts(hash, 72);
        let chain: [u8; 32] = context[..32].try_into().map_err(|_| Error::Encoding)?;
        let expires = u64::from_be_bytes(context[32..40].try_into().map_err(|_| Error::Encoding)?);
        let approval: [u8; 32] = context[40..72].try_into().map_err(|_| Error::Encoding)?;
        let b = verify(
            std::slice::from_raw_parts(data, len),
            &chain,
            expires,
            &approval,
        )?;
        let mut bytes = Vec::with_capacity(200);
        bytes.extend(b.value_balance().to_le_bytes());
        bytes.extend(b.anchor().to_bytes());
        bytes.extend(effects(&b)?);
        for a in b.actions().iter() {
            bytes.extend(a.nullifier().to_bytes());
            bytes.extend(a.cmx().to_bytes());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 200);
        Ok::<(), Error>(())
    });
    match result {
        Ok(Ok(())) => 0,
        _ => 1,
    }
}
#[no_mangle]
pub unsafe extern "C" fn uain_orchard_effects(data: *const u8, len: usize, out: *mut u8) -> i32 {
    if data.is_null() || out.is_null() || len != wire_size() {
        return 1;
    }
    match std::panic::catch_unwind(|| {
        decode(std::slice::from_raw_parts(data, len)).and_then(|b| effects(&b))
    }) {
        Ok(Ok(bytes)) => {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 32);
            0
        }
        _ => 1,
    }
}
#[no_mangle]
pub unsafe extern "C" fn uain_orchard_combine(
    level: u8,
    left: *const u8,
    right: *const u8,
    out: *mut u8,
) -> i32 {
    if left.is_null() || right.is_null() || out.is_null() {
        return 1;
    }
    match std::panic::catch_unwind(|| {
        combine(
            level,
            *(left as *const [u8; 32]),
            *(right as *const [u8; 32]),
        )
    }) {
        Ok(Ok(bytes)) => {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 32);
            0
        }
        _ => 1,
    }
}
#[no_mangle]
pub unsafe extern "C" fn uain_orchard_empty(level: u8, out: *mut u8) -> i32 {
    if out.is_null() {
        return 1;
    }
    match empty(level) {
        Ok(bytes) => {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 32);
            0
        }
        _ => 1,
    }
}

/// Public effects with deliberately invalid zero authorization, for a private checker
/// to recover outputs with a single-use viewing key before issuing approval.
/// This object is never valid for consensus; proof/signatures must be added by the wallet.
pub fn encode_for_review<T: Authorization>(bundle: &Bundle<T, i64>) -> Result<Vec<u8>, Error> {
    if bundle.actions().len() != ACTIONS
        || bundle.bundle_version() != version()
        || bundle.flags() != &version().default_flags()
    {
        return Err(Error::Encoding);
    }
    let mut out = Vec::with_capacity(wire_size());
    out.extend(MAGIC);
    out.extend(bundle.value_balance().to_le_bytes());
    out.extend(bundle.anchor().to_bytes());
    for a in bundle.actions().iter() {
        out.extend(a.cv_net().to_bytes());
        out.extend(a.nullifier().to_bytes());
        out.extend(<[u8; 32]>::from(a.rk()));
        out.extend(a.cmx().to_bytes());
        out.extend(a.encrypted_note().epk_bytes);
        out.extend(a.encrypted_note().enc_ciphertext.0);
        out.extend(a.encrypted_note().out_ciphertext);
        out.extend([0; 64]);
    }
    out.resize(wire_size(), 0);
    Ok(out)
}
