//! Inactive offline prototype verifier. `PinnedSnapshot` is a caller assertion,
//! NOT a header/state-proof verifier. Native code must authenticate it first.
//! A single appointed reviewer attests licensed eligibility of the SAME owner
//! by checking the SpendAuth challenge and encrypted member credentials. The
//! signature here authenticates that review; no licence ZK is claimed.
use super::{domain_tag, hash, K};
use ed25519_dalek::{Signature as ReviewSignature, VerifyingKey as ReviewerKey};
use halo2_proofs::{
    plonk::{verify_proof, SingleVerifier, VerifyingKey},
    poly::commitment::Params,
    transcript::{Blake2bRead, Challenge255},
};
use orchard::primitives::redpallas::{Signature, SpendAuth, VerificationKey};
use pasta_curves::{
    arithmetic::{Coordinates, CurveAffine},
    group::{ff::PrimeField, GroupEncoding},
    pallas, vesta,
};

pub const PUBLIC_INPUTS: usize = 50;
const MAX_PROOF: usize = 64 * 1024;
/// Must originate from an authenticated H record, checked against header H+1.
/// Full minted supply counts ALL transparent+shielded Coin; not Reserved.
pub struct PinnedSnapshot {
    pub note_root: pallas::Base,
    pub nullifier_root: pallas::Base,
    pub context: [pallas::Base; 2],
    pub pool: [u8; 33],
    pub minted: [u8; 9],
}
impl PinnedSnapshot {
    pub fn matches(&self, public: &[pallas::Base]) -> Result<(), &'static str> {
        if public.len() != PUBLIC_INPUTS {
            return Err("wrong statement width");
        }
        if public[..4]
            != [
                self.note_root,
                self.nullifier_root,
                self.context[0],
                self.context[1],
            ]
        {
            return Err("snapshot/context mismatch");
        }
        if public[8..]
            .iter()
            .zip(self.pool.iter().chain(&self.minted))
            .any(|(a, b)| *a != pallas::Base::from(*b as u64))
        {
            return Err("pool/full minted mismatch");
        }
        // Receipt context is a 32-byte canonical digest split into two 128-bit
        // limbs by the native wrapper, with no lossy reduction into a field.
        if public[2..4]
            .iter()
            .any(|v| v.to_repr()[16..].iter().any(|b| *b != 0))
        {
            return Err("noncanonical context limb");
        }
        Ok(())
    }
}
/// Unique fixed-length binary statement, signed by the actual note owner.
/// It includes authenticated roots, receipt context, randomized owner key,
/// claim NF, blinded effects commitment, exact pool and full minted denominator.
pub fn statement_bytes(public: &[pallas::Base]) -> Result<Vec<u8>, &'static str> {
    if public.len() != PUBLIC_INPUTS {
        return Err("wrong statement width");
    }
    let mut out = b"UAIN dividend prototype statement v1\0".to_vec();
    for value in public {
        out.extend_from_slice(&value.to_repr());
    }
    Ok(out)
}
pub fn verify_spend_signature(
    public: &[pallas::Base],
    sig: &Signature<SpendAuth>,
) -> Result<(), &'static str> {
    let message = statement_bytes(public)?;
    let point = Option::<pallas::Affine>::from(pallas::Affine::from_xy(public[4], public[5]))
        .ok_or("invalid randomized key")?;
    let _ = Option::<Coordinates<pallas::Affine>>::from(point.coordinates())
        .ok_or("identity randomized key")?;
    let key = VerificationKey::<SpendAuth>::try_from(point.to_bytes())
        .map_err(|_| "invalid randomized key")?;
    key.verify(&message, sig)
        .map_err(|_| "invalid spend authorization")
}
/// No party/member ID is public. Review takes place over authenticated encrypted
/// transport. The pinned reviewer, not the claimant, supplies the eligibility
/// assurance; there is exactly ONE trusted reviewer in this prototype.
pub struct LicensedApproval {
    pub valid_until: u64,
    pub signature: [u8; 64],
}
pub fn review_message(public: &[pallas::Base], valid_until: u64) -> Result<Vec<u8>, &'static str> {
    let mut out = b"UAIN licensed dividend owner review v1\0".to_vec();
    out.extend_from_slice(&valid_until.to_le_bytes());
    out.extend_from_slice(&statement_bytes(public)?);
    Ok(out)
}
pub fn verify_licensed_approval(
    public: &[pallas::Base],
    approval: &LicensedApproval,
    pinned_reviewer: [u8; 32],
    now: u64,
) -> Result<(), &'static str> {
    if approval.valid_until < now {
        return Err("expired licensed review");
    }
    let key =
        ReviewerKey::from_bytes(&pinned_reviewer).map_err(|_| "invalid appointed reviewer")?;
    key.verify_strict(
        &review_message(public, approval.valid_until)?,
        &ReviewSignature::from_bytes(&approval.signature),
    )
    .map_err(|_| "invalid licensed review")
}
/// Recompute a PRIVATE recipient/payout opening before creating a shielded
/// payment. A public native transfer would reveal recipient/amount; this module
/// does not supply a confidential external-asset rail or a payout operation.
pub fn verify_effect_opening(
    public: &[pallas::Base],
    recipient: [pallas::Base; 2],
    quotient: [u8; 33],
    blind: pallas::Base,
) -> Result<(), &'static str> {
    if public.len() != PUBLIC_INPUTS {
        return Err("wrong statement width");
    }
    if recipient
        .iter()
        .any(|v| v.to_repr()[16..].iter().any(|b| *b != 0))
    {
        return Err("noncanonical recipient digest limb");
    }
    let domain = hash::poseidon_hash_3(domain_tag(), public[2], public[3]);
    let mut effect = hash::poseidon_hash_3(domain, public[6], blind);
    effect = hash::poseidon_hash_3(effect, recipient[0], recipient[1]);
    for b in quotient {
        effect = hash::poseidon_hash_2(effect, pallas::Base::from(b as u64));
    }
    if effect != public[7] {
        return Err("private effect opening mismatch");
    }
    Ok(())
}
/// Verifies a candidate against EXTERNALLY authenticated inputs. This performs
/// no ledger writes and cannot enable claims. Consensus snapshot construction,
/// state-proof authentication, duplicate consumption and shielded payment are
/// deliberately absent. The VK must be pinned by the application, not supplied
/// by a claimant. `params` must be the expected K=12 Pasta parameter set.
#[allow(clippy::too_many_arguments)]
fn verify_at_k(
    expected_k: u32,
    params: &Params<vesta::Affine>,
    vk: &VerifyingKey<vesta::Affine>,
    pinned: &PinnedSnapshot,
    public: &[pallas::Base],
    proof: &[u8],
    spend: &Signature<SpendAuth>,
    review: &LicensedApproval,
    pinned_reviewer: [u8; 32],
    now: u64,
) -> Result<(), &'static str> {
    if proof.is_empty() || proof.len() > MAX_PROOF {
        return Err("invalid proof size");
    }
    if params.k() != expected_k {
        return Err("wrong circuit parameters");
    }
    pinned.matches(public)?;
    verify_spend_signature(public, spend)?;
    verify_licensed_approval(public, review, pinned_reviewer, now)?;
    let mut cursor = std::io::Cursor::new(proof);
    let mut transcript = Blake2bRead::<_, vesta::Affine, Challenge255<_>>::init(&mut cursor);
    verify_proof(
        params,
        vk,
        SingleVerifier::new(params),
        &[&[public]],
        &mut transcript,
    )
    .map_err(|_| "invalid snapshot ratio proof")?;
    drop(transcript);
    if cursor.position() != proof.len() as u64 {
        return Err("trailing proof bytes");
    }
    Ok(())
}

/// Offline verification under an externally pinned VK and authenticated snapshot.
/// The native full-domain route must use verify_full_candidate exclusively.
#[allow(clippy::too_many_arguments)]
pub fn verify_candidate(
    params: &Params<vesta::Affine>,
    vk: &VerifyingKey<vesta::Affine>,
    pinned: &PinnedSnapshot,
    public: &[pallas::Base],
    proof: &[u8],
    spend: &Signature<SpendAuth>,
    review: &LicensedApproval,
    pinned_reviewer: [u8; 32],
    now: u64,
) -> Result<(), &'static str> {
    verify_at_k(
        K,
        params,
        vk,
        pinned,
        public,
        proof,
        spend,
        review,
        pinned_reviewer,
        now,
    )
}

/// Offline verification under an externally pinned VK and authenticated snapshot.
/// The native full-domain route must use verify_full_candidate exclusively.
#[allow(clippy::too_many_arguments)]
pub fn verify_full_candidate(
    params: &Params<vesta::Affine>,
    vk: &VerifyingKey<vesta::Affine>,
    pinned: &PinnedSnapshot,
    public: &[pallas::Base],
    proof: &[u8],
    spend: &Signature<SpendAuth>,
    review: &LicensedApproval,
    pinned_reviewer: [u8; 32],
    now: u64,
) -> Result<(), &'static str> {
    verify_at_k(
        super::FULL_SNAPSHOT_K,
        params,
        vk,
        pinned,
        public,
        proof,
        spend,
        review,
        pinned_reviewer,
        now,
    )
}
