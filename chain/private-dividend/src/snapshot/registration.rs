//! Inactive canonical per-member carry-control commitment. Native registration
//! must separately authenticate original Ed25519 member consent, current licence
//! and uniqueness. The matching randomized Orchard signature is mandatory.
//! This proves control of the registered spending authority, not a real-world
//! identity or the relationship to another origin FVK; the appointed trusted
//! reviewer must explicitly attest that same-member provenance for full claims.
use super::*;
use orchard::primitives::redpallas::{Signature, SpendAuth, VerificationKey};
type F = pallas::Base;
pub const REGISTRATION_K: u32 = 12;
pub const PUBLIC_INPUTS: usize = 6;
const CONTROL_TAG: u64 = 0x5541494e52454701;
#[derive(Clone, Debug, Default)]
pub struct RegistrationCircuit {
    nk: Value<NullifierDerivingKey>,
    ak: Value<SpendValidatingKey>,
    alpha: Value<pallas::Scalar>,
    blind: Value<F>,
    public: Value<[F; PUBLIC_INPUTS]>,
}
/// These cells must be reused by the full carry/registered-licence gadget.
/// Matching independent host commitments is not a proof of shared control.
pub(crate) struct ControlCells {
    pub nk: AssignedCell<F, F>,
    pub commitment: AssignedCell<F, F>,
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn assign_control(
    c: &Config,
    nk: Value<NullifierDerivingKey>,
    ak: Value<SpendValidatingKey>,
    alpha: Value<pallas::Scalar>,
    blind: Value<F>,
    rk_rows: [usize; 2],
    l: &mut impl Layouter<F>,
) -> Result<ControlCells, plonk::Error> {
    let ecc = c.ecc_chip();
    let ak = NonIdentityPoint::new(
        ecc.clone(),
        l.namespace(|| "registered spending authority"),
        ak.as_ref().map(|a| pallas::Point::from(a).to_affine()),
    )?;
    let point: Point<pallas::Affine, EccChip<OrchardFixedBases>> = ak.into();
    spend_authority::prove_spend_authority(
        ecc,
        l.namespace(|| "registered randomized control"),
        alpha,
        &point,
        c.primary,
        rk_rows[0],
        rk_rows[1],
    )?;
    let nk = assign_free_advice(
        l.namespace(|| "registered carry key"),
        c.advices[0],
        nk.map(|n| n.inner()),
    )?;
    let blind = assign_free_advice(
        l.namespace(|| "registered control blind"),
        c.advices[0],
        blind,
    )?;
    let tag = l.assign_region(
        || "registration domain",
        |mut r| {
            r.assign_advice_from_constant(|| "control v1", c.advices[0], 0, F::from(CONTROL_TAG))
        },
    )?;
    let hidden = poseidon_hash_in_circuit(
        c.poseidon_chip(),
        l.namespace(|| "registered secret commitment"),
        "control",
        [tag, nk.clone(), blind],
    )?;
    let commitment = poseidon_hash_in_circuit(
        c.poseidon_chip(),
        l.namespace(|| "registered spend authority commitment"),
        "authority",
        [hidden, point.inner().x().clone(), point.inner().y().clone()],
    )?;
    Ok(ControlCells { nk, commitment })
}
impl plonk::Circuit<F> for RegistrationCircuit {
    type Config = Config;
    type FloorPlanner = floor_planner::V1;
    fn without_witnesses(&self) -> Self {
        Self::default()
    }
    fn configure(meta: &mut plonk::ConstraintSystem<F>) -> Config {
        Config::configure(meta)
    }
    fn synthesize(&self, c: Config, mut l: impl Layouter<F>) -> Result<(), plonk::Error> {
        SinsemillaChip::load(c.sinsemilla_config_1.clone(), &mut l)?;
        let control = assign_control(
            &c,
            self.nk,
            self.ak.clone(),
            self.alpha,
            self.blind,
            [3, 4],
            &mut l,
        )?;
        l.constrain_instance(control.commitment.cell(), c.primary, 0)?;
        let context: [AssignedCell<F, F>; 2] = [1usize, 2usize]
            .map(|row| {
                let cell = assign_free_advice(
                    l.namespace(|| format!("native member consent context{row}")),
                    c.advices[0],
                    self.public.map(|p| p[row]),
                )?;
                l.constrain_instance(cell.cell(), c.primary, row)?;
                Ok(cell)
            })
            .into_iter()
            .collect::<Result<Vec<_>, plonk::Error>>()?
            .try_into()
            .map_err(|_| plonk::Error::Synthesis)?;
        let effects = poseidon_hash_in_circuit(
            c.poseidon_chip(),
            l.namespace(|| "member consent effects"),
            "consent",
            [control.commitment, context[0].clone(), context[1].clone()],
        )?;
        l.constrain_instance(effects.cell(), c.primary, 5)?;
        Ok(())
    }
}
impl RegistrationCircuit {
    pub fn from_parts(
        fvk: &FullViewingKey,
        alpha: pallas::Scalar,
        blind: F,
        context: [F; 2],
    ) -> Result<(Self, Vec<F>), &'static str> {
        if context
            .iter()
            .any(|v| v.to_repr()[16..].iter().any(|b| *b != 0))
        {
            return Err("noncanonical consent context limb");
        }
        let ak = SpendValidatingKey::from(fvk.clone());
        let point = pallas::Point::from(&ak).to_affine();
        let coords = Option::<Coordinates<pallas::Affine>>::from(point.coordinates())
            .ok_or("identity spending authority")?;
        let hidden = hash::poseidon_hash_3(F::from(CONTROL_TAG), fvk.nk().inner(), blind);
        let commitment = hash::poseidon_hash_3(hidden, *coords.x(), *coords.y());
        let rk = Option::<pallas::Point>::from(pallas::Point::from_bytes(&<[u8; 32]>::from(
            ak.randomize(&alpha),
        )))
        .ok_or("invalid randomized control")?
        .to_affine();
        let rk = Option::<Coordinates<pallas::Affine>>::from(rk.coordinates())
            .ok_or("identity randomized control")?;
        let public = [
            commitment,
            context[0],
            context[1],
            *rk.x(),
            *rk.y(),
            hash::poseidon_hash_3(commitment, context[0], context[1]),
        ];
        Ok((
            Self {
                nk: Value::known(*fvk.nk()),
                ak: Value::known(ak),
                alpha: Value::known(alpha),
                blind: Value::known(blind),
                public: Value::known(public),
            },
            public.to_vec(),
        ))
    }
}
pub fn statement_bytes(public: &[F]) -> Result<Vec<u8>, &'static str> {
    if public.len() != PUBLIC_INPUTS
        || public[1..3]
            .iter()
            .any(|v| v.to_repr()[16..].iter().any(|b| *b != 0))
    {
        return Err("invalid canonical registration statement");
    }
    let mut out = b"UAIN/dividend/member-carry-registration/v1\0".to_vec();
    for v in public {
        out.extend_from_slice(&v.to_repr())
    }
    Ok(out)
}
pub fn verify_signature(
    public: &[F],
    signature: &Signature<SpendAuth>,
) -> Result<(), &'static str> {
    let message = statement_bytes(public)?;
    let point = Option::<pallas::Affine>::from(pallas::Affine::from_xy(public[3], public[4]))
        .ok_or("invalid randomized registration key")?;
    let _ = Option::<Coordinates<pallas::Affine>>::from(point.coordinates())
        .ok_or("identity randomized registration key")?;
    let key = VerificationKey::<SpendAuth>::try_from(point.to_bytes())
        .map_err(|_| "invalid registered key")?;
    key.verify(&message, signature)
        .map_err(|_| "invalid registered spend authorization")
}
#[cfg(test)]
mod tests;

/// Fixed circuit parameters/VK are constructed from this exact compiled circuit,
/// never supplied by the claimant. This accepts registration only; it cannot
/// authorize a dividend claim or a native policy activation.
pub fn verify_registration(
    public: &[F],
    proof: &[u8],
    signature: &Signature<SpendAuth>,
) -> Result<(), &'static str> {
    use halo2_proofs::{
        plonk::{keygen_vk, verify_proof, SingleVerifier, VerifyingKey},
        poly::commitment::Params,
        transcript::{Blake2bRead, Challenge255},
    };
    use pasta_curves::vesta;
    use std::sync::OnceLock;
    if proof.is_empty() || proof.len() > 64 * 1024 {
        return Err("invalid registration proof size");
    }
    verify_signature(public, signature)?;
    static KEY: OnceLock<Result<(Params<vesta::Affine>, VerifyingKey<vesta::Affine>), ()>> =
        OnceLock::new();
    let (params, vk) = KEY
        .get_or_init(|| {
            let params = Params::new(REGISTRATION_K);
            let vk = keygen_vk(&params, &RegistrationCircuit::default()).map_err(|_| ())?;
            Ok((params, vk))
        })
        .as_ref()
        .map_err(|_| "registration verifying key unavailable")?;
    let mut cursor = std::io::Cursor::new(proof);
    let mut transcript = Blake2bRead::<_, vesta::Affine, Challenge255<_>>::init(&mut cursor);
    verify_proof(
        params,
        vk,
        SingleVerifier::new(params),
        &[&[public]],
        &mut transcript,
    )
    .map_err(|_| "invalid registration proof")?;
    drop(transcript);
    if cursor.position() != proof.len() as u64 {
        return Err("trailing registration proof bytes");
    };
    Ok(())
}

/// Client-side reconstruction of the context independently pinned by native
/// code. Length framing and exact 128-bit digest limbs avoid lossy reduction.
pub fn native_context(
    chain: &str,
    genesis: [u8; 32],
    member: [u8; 32],
    control: F,
) -> Result<[F; 2], &'static str> {
    use sha2::{Digest, Sha256};
    let valid = chain.len() > 0
        && chain.len() <= 128
        && chain
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphanumeric() || (i > 0 && b"._:-".contains(&b)));
    if !valid || genesis == [0; 32] {
        return Err("invalid canonical registration chain/genesis");
    }
    let mut b = b"UAIN/dividend/member-carry-context/v1\0".to_vec();
    for v in [
        crate::snapshot::registration::CONTEXT_VERSION.as_bytes(),
        chain.as_bytes(),
    ] {
        b.extend_from_slice(&(v.len() as u32).to_be_bytes());
        b.extend_from_slice(v)
    }
    b.extend_from_slice(&genesis);
    b.extend_from_slice(&member);
    b.extend_from_slice(&control.to_repr());
    let digest = Sha256::digest(b);
    Ok([
        F::from_u128(u128::from_le_bytes(digest[..16].try_into().unwrap())),
        F::from_u128(u128::from_le_bytes(digest[16..].try_into().unwrap())),
    ])
}
pub const CONTEXT_VERSION: &str = "uain-dividend-member-carry-v1";
