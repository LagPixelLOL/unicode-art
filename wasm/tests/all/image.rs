use unicode_art_core::image::prepare_target;

fn solid(w: usize, h: usize, px: [u8; 4]) -> Vec<u8> {
    px.iter().copied().cycle().take(w * h * 4).collect()
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 2e-3
}

#[test]
fn transparent_pixels_become_white() {
    let img = solid(3, 2, [0, 0, 0, 0]);
    assert!(prepare_target(&img, 3, 2, 3, 2, false).iter().all(|&v| close(v, 1.0)));
    assert!(prepare_target(&img, 3, 2, 3, 2, true).iter().all(|&v| close(v, 0.0)));
}

#[test]
fn colours_become_greyscale_luminance() {
    let black = prepare_target(&solid(1, 1, [0, 0, 0, 255]), 1, 1, 1, 1, false);
    assert!(close(black[0], 0.0));
    // Pure green is far brighter than pure blue.
    let g = prepare_target(&solid(1, 1, [0, 255, 0, 255]), 1, 1, 1, 1, false)[0];
    let b = prepare_target(&solid(1, 1, [0, 0, 255, 255]), 1, 1, 1, 1, false)[0];
    assert!(g > 0.8 && b < 0.4, "g={g} b={b}");
    // Grey stays the same grey.
    let grey = prepare_target(&solid(1, 1, [128, 128, 128, 255]), 1, 1, 1, 1, false)[0];
    assert!(close(grey, 128.0 / 255.0), "{grey}");
    // Half transparent black over white is a mid grey.
    let half = prepare_target(&solid(1, 1, [0, 0, 0, 128]), 1, 1, 1, 1, false)[0];
    assert!(close(half, 127.0 / 255.0), "{half}");
}

#[test]
fn downscaling_averages_in_linear_light() {
    // A black and white checkerboard averages to 50% linear light, which is
    // about 0.735 in sRGB.
    let mut img = Vec::new();
    for y in 0..4 {
        for x in 0..4 {
            let v = if (x + y) % 2 == 0 { 255 } else { 0 };
            img.extend([v, v, v, 255]);
        }
    }
    let out = prepare_target(&img, 4, 4, 2, 2, false);
    assert!(out.iter().all(|&v| (v - 0.7354).abs() < 1e-3), "{out:?}");
    // Non integer factors keep a uniform image uniform.
    let out = prepare_target(&solid(7, 5, [200, 200, 200, 255]), 7, 5, 3, 2, false);
    assert!(out.iter().all(|&v| close(v, 200.0 / 255.0)));
}

#[test]
fn upscaling_interpolates_and_keeps_orientation() {
    // Left column black, right column white.
    let img = [0, 0, 0, 255, 255, 255, 255, 255];
    let out = prepare_target(&img, 2, 1, 8, 2, false);
    assert_eq!(out.len(), 16);
    for row in out.chunks(8) {
        assert!(close(row[0], 0.0) && close(row[7], 1.0));
        assert!(row.windows(2).all(|w| w[0] <= w[1] + 1e-6), "monotonic {row:?}");
    }
    let inv = prepare_target(&img, 2, 1, 8, 2, true);
    assert!(out.iter().zip(&inv).all(|(a, b)| close(a + b, 1.0)));
}

#[test]
#[should_panic(expected = "rgba length mismatch")]
fn rejects_mismatched_buffers() {
    prepare_target(&[0; 8], 3, 1, 1, 1, false);
}
