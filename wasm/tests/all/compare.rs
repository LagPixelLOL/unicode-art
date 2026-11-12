use unicode_art_core::compare::compare_rgba;

fn grey(values: &[u8]) -> Vec<u8> {
    values.iter().flat_map(|&v| [v, 0, 0, 255]).collect()
}

#[test]
fn identical_images_are_fully_similar() {
    let a = [10, 1, 2, 255, 200, 0, 0, 255];
    let c = compare_rgba(&a, &a, 2, 0.1, 0);
    assert_eq!(c.pixels, 2);
    assert_eq!(c.abs_diff, 0.0);
    assert_eq!(c.differing, 0);
    assert_eq!(c.similarity(), 1.0);
}

#[test]
fn measures_differences_on_the_red_channel() {
    let a = [255, 0, 0, 255, 0, 0, 0, 255, 51, 9, 9, 9];
    let b = [0, 0, 0, 255, 0, 77, 77, 77, 102, 0, 0, 0];
    let c = compare_rgba(&a, &b, 3, 0.5, 0);
    assert_eq!(c.pixels, 3);
    assert!((c.abs_diff - 1.2).abs() < 1e-6);
    assert!((c.ink_a - 1.2).abs() < 1e-6 && (c.ink_b - 0.4).abs() < 1e-6);
    assert!((c.max_diff - 1.0).abs() < 1e-6);
    assert_eq!(c.differing, 1);
    assert!(c.similarity() < 1e-6);
}

#[test]
fn blur_ignores_texture_phase_but_not_missing_ink() {
    // A one pixel checkerboard and the same pattern shifted by one pixel.
    let (w, h) = (8, 8);
    let pattern = |shift: usize| -> Vec<u8> {
        (0..w * h)
            .map(|i| {
                if ((i % w) + (i / w) + shift).is_multiple_of(2) {
                    255
                } else {
                    0
                }
            })
            .collect()
    };
    let a = grey(&pattern(0));
    let b = grey(&pattern(1));
    assert!(compare_rgba(&a, &b, w, 0.25, 0).similarity() < 0.01);
    let blurred = compare_rgba(&a, &b, w, 0.25, 1);
    assert!(blurred.similarity() > 0.8, "{}", blurred.similarity());
    // Removing the ink entirely is still detected after blurring.
    let empty = grey(&vec![0; w * h]);
    assert!(compare_rgba(&a, &empty, w, 0.25, 1).similarity() < 0.01);
    // The blur roughly preserves the total ink.
    let c = compare_rgba(&a, &a, w, 0.25, 1);
    assert!((c.ink_a - 32.0).abs() < 1.0, "{}", c.ink_a);
}

#[test]
fn blank_images_are_similar() {
    assert_eq!(compare_rgba(&[0; 8], &[0; 8], 1, 0.0, 1).similarity(), 1.0);
}

#[test]
#[should_panic(expected = "size mismatch")]
fn rejects_different_sizes() {
    compare_rgba(&[0; 4], &[0; 8], 1, 0.0, 0);
}

#[test]
#[should_panic(expected = "width does not match")]
fn rejects_wrong_width() {
    compare_rgba(&[0; 12], &[0; 12], 2, 0.0, 0);
}
