use unicode_art_core::compare::compare_rgba;

#[test]
fn identical_images_are_fully_similar() {
    let a = [10, 1, 2, 255, 200, 0, 0, 255];
    let c = compare_rgba(&a, &a, 0.1);
    assert_eq!(c.pixels, 2);
    assert_eq!(c.abs_diff, 0.0);
    assert_eq!(c.differing, 0);
    assert_eq!(c.similarity(), 1.0);
}

#[test]
fn measures_differences_on_the_red_channel() {
    let a = [255, 0, 0, 255, 0, 0, 0, 255, 51, 9, 9, 9];
    let b = [0, 0, 0, 255, 0, 77, 77, 77, 102, 0, 0, 0];
    let c = compare_rgba(&a, &b, 0.5);
    assert_eq!(c.pixels, 3);
    assert!((c.abs_diff - 1.2).abs() < 1e-9);
    assert!((c.ink_a - 1.2).abs() < 1e-9 && (c.ink_b - 0.4).abs() < 1e-9);
    assert_eq!(c.max_diff, 1.0);
    assert_eq!(c.differing, 1);
    assert!(c.similarity() < 1e-9);
}

#[test]
fn blank_images_are_similar() {
    assert_eq!(compare_rgba(&[0; 8], &[0; 8], 0.0).similarity(), 1.0);
}

#[test]
#[should_panic(expected = "size mismatch")]
fn rejects_different_sizes() {
    compare_rgba(&[0; 4], &[0; 8], 0.0);
}
