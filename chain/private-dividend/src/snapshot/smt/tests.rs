use super::*;
use pasta_curves::group::ff::PrimeField;
#[test]
fn full_field_domain_empty_and_occupied_boundaries() {
    let zero = F::zero().to_repr();
    let max = (-F::one()).to_repr();
    let mut tree = SparseTree::new();
    let empty_root = tree.root();
    for key in [zero, max] {
        let path = tree.path(key).unwrap();
        assert!(verify_absence(tree.root(), key, &path).unwrap());
        tree.insert(key).unwrap();
        assert!(!verify_absence(tree.root(), key, &tree.path(key).unwrap()).unwrap());
    }
    assert_ne!(tree.root(), empty_root);
    assert_eq!(tree.insert(zero), Err(TreeError::Duplicate));
}
#[test]
fn insertion_order_and_exact_historical_paths() {
    let keys = [0, 1, 2, 17, 19, 255, 256, 65535].map(|v| F::from(v).to_repr());
    let mut tree = SparseTree::new();
    let h0 = tree.root();
    let h0path = tree.path(keys[0]).unwrap();
    for key in keys {
        tree.insert(key).unwrap();
    }
    let mut reversed = SparseTree::new();
    for key in keys.into_iter().rev() {
        reversed.insert(key).unwrap();
    }
    assert_eq!(tree.root(), reversed.root());
    assert!(verify_absence(h0, keys[0], &h0path).unwrap());
    assert!(!verify_absence(tree.root(), keys[0], &h0path).unwrap());
    let gap = F::from(18).to_repr();
    let path = tree.path(gap).unwrap();
    assert!(verify_absence(tree.root(), gap, &path).unwrap());
    let mut corrupt = path;
    corrupt[255] += F::one();
    assert!(!verify_absence(tree.root(), gap, &corrupt).unwrap());
}
#[test]
fn reject_noncanonical_aliases_and_short_paths() {
    let mut p = (-F::one()).to_repr();
    let mut carry = 1u16;
    for b in &mut p {
        let n = *b as u16 + carry;
        *b = n as u8;
        carry = n >> 8;
    }
    assert_eq!(SparseTree::new().path(p), Err(TreeError::NonCanonical));
    assert_eq!(SparseTree::new().insert(p), Err(TreeError::NonCanonical));
    assert_eq!(
        verify_absence(F::zero(), [0; 32], &[]),
        Err(TreeError::PathLength)
    );
    assert_eq!(
        verify_absence(F::zero(), p, &[F::zero(); 256]),
        Err(TreeError::NonCanonical)
    );
}
