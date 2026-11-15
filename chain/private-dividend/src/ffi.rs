//! Fixed-width public hashing FFI. No proof acceptance or policy activation.
use crate::snapshot::smt;
use pasta_curves::{group::ff::PrimeField, pallas};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::OnceLock,
};
unsafe fn input(p: *const u8) -> Option<[u8; 32]> {
    if p.is_null() {
        return None;
    };
    let mut b = [0; 32];
    unsafe { std::ptr::copy_nonoverlapping(p, b.as_mut_ptr(), 32) };
    Some(b)
}
fn boundary(out: *mut u8, f: impl FnOnce() -> Option<pallas::Base>) -> i32 {
    if out.is_null() {
        return -1;
    };
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Some(v)) => {
            unsafe { std::ptr::copy_nonoverlapping(v.to_repr().as_ptr(), out, 32) };
            0
        }
        _ => -1,
    }
}
#[no_mangle]
pub unsafe extern "C" fn uain_dividend_smt_leaf(key: *const u8, out: *mut u8) -> i32 {
    boundary(out, || smt::occupied_leaf(unsafe { input(key) }?).ok())
}
#[no_mangle]
pub unsafe extern "C" fn uain_dividend_smt_node(
    level: u16,
    left: *const u8,
    right: *const u8,
    out: *mut u8,
) -> i32 {
    boundary(out, || {
        if level >= 256 {
            return None;
        };
        Some(smt::node(
            level as usize,
            smt::canonical(unsafe { input(left) }?).ok()?,
            smt::canonical(unsafe { input(right) }?).ok()?,
        ))
    })
}
#[no_mangle]
pub unsafe extern "C" fn uain_dividend_smt_empty(height: u16, out: *mut u8) -> i32 {
    boundary(out, || {
        if height > 256 {
            return None;
        };
        static EMPTY: OnceLock<Vec<pallas::Base>> = OnceLock::new();
        let e = EMPTY.get_or_init(|| {
            let mut v = vec![smt::empty_leaf()];
            for i in 0..256 {
                v.push(smt::node(i, v[i], v[i]))
            }
            v
        });
        Some(e[height as usize])
    })
}
/// Hashes only public registered-member data; no secret witness crosses this FFI.
#[no_mangle]
pub unsafe extern "C" fn uain_dividend_owner_leaf(
    member: *const u8,
    control: *const u8,
    active: u8,
    out: *mut u8,
) -> i32 {
    boundary(out, || {
        if active > 1 {
            return None;
        };
        Some(crate::snapshot::licensed::leaf(
            crate::snapshot::licensed::member_limbs(unsafe { input(member) }?),
            smt::canonical(unsafe { input(control) }?).ok()?,
            active == 1,
        ))
    })
}
#[no_mangle]
pub unsafe extern "C" fn uain_dividend_owner_node(
    level: u8,
    left: *const u8,
    right: *const u8,
    out: *mut u8,
) -> i32 {
    boundary(out, || {
        if level >= 32 {
            return None;
        };
        Some(crate::snapshot::licensed::node(
            level as usize,
            smt::canonical(unsafe { input(left) }?).ok()?,
            smt::canonical(unsafe { input(right) }?).ok()?,
        ))
    })
}
#[no_mangle]
pub unsafe extern "C" fn uain_dividend_owner_empty(height: u8, out: *mut u8) -> i32 {
    boundary(out, || {
        if height > 32 {
            return None;
        };
        static EMPTY: OnceLock<Vec<pallas::Base>> = OnceLock::new();
        let e = EMPTY.get_or_init(|| {
            let mut v = vec![crate::snapshot::licensed::empty_leaf()];
            for i in 0..32 {
                v.push(crate::snapshot::licensed::node(i, v[i], v[i]))
            }
            v
        });
        Some(e[height as usize])
    })
}
/// Fixed 192-byte canonical public statement + bounded proof + fixed 64-byte
/// randomized Orchard authorization. The native caller must pin context/member
/// consent and unique registration. No caller-supplied VK or params are accepted.
#[no_mangle]
pub unsafe extern "C" fn uain_dividend_registration_verify(
    public: *const u8,
    proof: *const u8,
    proof_len: usize,
    signature: *const u8,
) -> i32 {
    match catch_unwind(AssertUnwindSafe(|| {
        if public.is_null()
            || proof.is_null()
            || signature.is_null()
            || proof_len == 0
            || proof_len > 64 * 1024
        {
            return None;
        };
        let public = unsafe { std::slice::from_raw_parts(public, 192) }
            .chunks_exact(32)
            .map(|v| smt::canonical(v.try_into().unwrap()).ok())
            .collect::<Option<Vec<_>>>()?;
        let mut sig = [0; 64];
        unsafe { std::ptr::copy_nonoverlapping(signature, sig.as_mut_ptr(), 64) };
        crate::snapshot::registration::verify_registration(
            &public,
            unsafe { std::slice::from_raw_parts(proof, proof_len) },
            &orchard::primitives::redpallas::Signature::from(sig),
        )
        .ok()
    })) {
        Ok(Some(())) => 0,
        _ => -1,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_width_hash_ffi_rejects_noncanonical_levels_and_nulls() {
        unsafe {
            let mut out = [0u8; 32];
            let zero = [0; 32];
            let mut p = (-pallas::Base::one()).to_repr();
            let mut c = 1u16;
            for b in &mut p {
                let n = *b as u16 + c;
                *b = n as u8;
                c = n >> 8;
            }
            assert_ne!(
                uain_dividend_smt_leaf(std::ptr::null(), out.as_mut_ptr()),
                0
            );
            assert_ne!(
                uain_dividend_smt_leaf(zero.as_ptr(), std::ptr::null_mut()),
                0
            );
            assert_ne!(uain_dividend_smt_leaf(p.as_ptr(), out.as_mut_ptr()), 0);
            assert_ne!(
                uain_dividend_smt_node(256, zero.as_ptr(), zero.as_ptr(), out.as_mut_ptr()),
                0
            );
            assert_ne!(uain_dividend_smt_empty(257, out.as_mut_ptr()), 0);
            assert_eq!(uain_dividend_smt_leaf(zero.as_ptr(), out.as_mut_ptr()), 0);
            assert_eq!(out, smt::occupied_leaf(zero).unwrap().to_repr());
        }
    }
    #[test]
    fn registered_owner_hash_ffi_canonical_domains_and_boundaries() {
        unsafe {
            let mut out = [0; 32];
            let member = [255; 32];
            let control = [0; 32];
            assert_eq!(
                uain_dividend_owner_leaf(member.as_ptr(), control.as_ptr(), 1, out.as_mut_ptr()),
                0
            );
            assert_eq!(
                out,
                crate::snapshot::licensed::leaf(
                    crate::snapshot::licensed::member_limbs(member),
                    pallas::Base::zero(),
                    true
                )
                .to_repr()
            );
            assert_ne!(
                uain_dividend_owner_leaf(member.as_ptr(), control.as_ptr(), 2, out.as_mut_ptr()),
                0
            );
            assert_ne!(
                uain_dividend_owner_leaf(std::ptr::null(), control.as_ptr(), 1, out.as_mut_ptr()),
                0
            );
            assert_ne!(
                uain_dividend_owner_leaf(member.as_ptr(), [255; 32].as_ptr(), 1, out.as_mut_ptr()),
                0
            );
            assert_ne!(
                uain_dividend_owner_node(32, control.as_ptr(), control.as_ptr(), out.as_mut_ptr()),
                0
            );
            assert_ne!(uain_dividend_owner_empty(33, out.as_mut_ptr()), 0);
            assert_eq!(uain_dividend_owner_empty(32, out.as_mut_ptr()), 0);
        }
    }
    #[test]
    fn publish_public_cross_language_tree_vectors() {
        let mut t = smt::SparseTree::new();
        let mut roots = vec![t.root().to_repr()];
        let keys = [
            pallas::Base::zero().to_repr(),
            (-pallas::Base::one()).to_repr(),
            pallas::Base::from(18).to_repr(),
        ];
        for key in keys {
            t.insert(key).unwrap();
            roots.push(t.root().to_repr());
        }
        if let Some(file) = std::env::var_os("UAIN_DIVIDEND_SMT_VECTORS") {
            let text = keys
                .iter()
                .chain(roots.iter())
                .map(|a| a.iter().map(|b| format!("{b:02x}")).collect::<String>())
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            std::fs::write(file, text).unwrap();
        }
    }
}
