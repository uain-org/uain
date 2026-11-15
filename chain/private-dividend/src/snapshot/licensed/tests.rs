use super::*;
use halo2_proofs::dev::MockProver;
use orchard::keys::SpendingKey;
use pasta_curves::group::ff::Field;
use rand::{rngs::StdRng, SeedableRng};
fn fixture() -> (LicensedCircuit, Vec<F>, F) {
    let mut rng = StdRng::seed_from_u64(0x5541494e4c4943);
    let sk = SpendingKey::random(&mut rng);
    let fvk = FullViewingKey::from(&sk);
    let path = core::array::from_fn(|i| F::from(i as u64 + 37));
    let control = registration::RegistrationCircuit::from_parts(
        &fvk,
        pallas::Scalar::from(1),
        F::from(7),
        [F::from(13), F::from(17)],
    )
    .unwrap()
    .1[0];
    let (c, p) = LicensedCircuit::from_parts(
        &fvk,
        pallas::Scalar::random(&mut rng),
        F::from(7),
        [0xa3; 32],
        19,
        path,
        [F::from(13), F::from(17)],
        F::from(23),
    )
    .unwrap();
    (c, p, control)
}
fn ok(c: &LicensedCircuit, p: Vec<F>) -> bool {
    MockProver::run(LICENSED_K, c, vec![p])
        .unwrap()
        .verify()
        .is_ok()
}
#[test]
fn current_licensed_leaf_binds_same_control_member_active_path_and_context() {
    let (c, p, control) = fixture();
    assert!(ok(&c, p.clone()));
    for i in 0..PUBLIC_INPUTS {
        let mut b = p.clone();
        b[i] += F::one();
        assert!(!ok(&c, b), "public{i}")
    }
    let mut b = c.clone();
    b.member = Value::known([F::from(1), F::from(2)]);
    assert!(!ok(&b, p.clone()));
    let mut b = c.clone();
    b.position = Value::known(20);
    assert!(!ok(&b, p.clone()));
    let mut b = c.clone();
    b.path = b.path.map(|mut s| {
        s[12] += F::one();
        s
    });
    assert!(!ok(&b, p.clone()));
    let mut b = c.clone();
    b.control_blind = Value::known(F::from(8));
    assert!(!ok(&b, p.clone()));
    let mut b = c.clone();
    b.effects_blind = Value::known(F::from(24));
    assert!(!ok(&b, p.clone()));
    let leaf = leaf(member_limbs([0xa3; 32]), control, false);
    let revoked = root(leaf, 19, core::array::from_fn(|i| F::from(i as u64 + 37)));
    let mut b = p.clone();
    b[0] = revoked;
    b[5] = hash::poseidon_hash_3(
        hash::poseidon_hash_3(revoked, b[3], b[4]),
        control,
        F::from(23),
    );
    assert!(!ok(&c, b));
}
#[test]
fn domains_and_license_state_are_distinct() {
    let member = member_limbs([0xff; 32]);
    let control = F::from(9);
    assert_ne!(leaf(member, control, true), leaf(member, control, false));
    assert_ne!(empty_leaf(), leaf([F::zero(); 2], F::zero(), false));
    assert_ne!(node(0, F::zero(), F::one()), node(1, F::zero(), F::one()));
    assert_ne!(node(0, F::zero(), F::one()), node(0, F::one(), F::zero()));
}

#[test]
fn publish_native_registry_root_vectors() {
    use std::collections::BTreeMap;
    let mut empty = vec![empty_leaf()];
    for i in 0..32 {
        empty.push(node(i, empty[i], empty[i]))
    }
    let mut nodes = BTreeMap::<(usize, u32), F>::new();
    let mut roots = vec![empty[32]];
    for (index, active) in [(0, true), (1, true), (2, true), (1, false)] {
        let mut member = [0; 32];
        member[0] = index as u8 + 1;
        let mut cur = leaf(member_limbs(member), F::from(index as u64 + 11), active);
        nodes.insert((0, index), cur);
        for level in 0..32 {
            let sibling = *nodes
                .get(&(level, (index >> level) ^ 1))
                .unwrap_or(&empty[level]);
            cur = if (index >> level) & 1 == 0 {
                node(level, cur, sibling)
            } else {
                node(level, sibling, cur)
            };
            nodes.insert((level + 1, ((index as u64) >> (level + 1)) as u32), cur);
        }
        roots.push(cur)
    }
    if let Some(path) = std::env::var_os("UAIN_DIVIDEND_OWNER_VECTORS") {
        let text = roots
            .into_iter()
            .map(|f| {
                f.to_repr()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(path, text).unwrap();
    }
}
