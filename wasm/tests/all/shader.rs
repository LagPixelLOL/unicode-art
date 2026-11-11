//! Validates the WGSL matcher with naga for representative parameters.

fn specialize(src: &str, params: &[(&str, u32)]) -> String {
    src.lines()
        .map(|line| {
            for &(name, value) in params {
                let prefix = format!("const {name}: u32 = ");
                if line.starts_with(&prefix) && line.contains("// param") {
                    return format!("{prefix}{value}u; // param");
                }
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn validate(src: &str) {
    let module = naga::front::wgsl::parse_str(src).unwrap_or_else(|e| panic!("{}", e.emit_to_string(src)));
    naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
        .validate(&module)
        .unwrap_or_else(|e| panic!("{e:?}"));
}

#[test]
fn matcher_shader_is_valid() {
    let path = crate::repo_root().join("src/engine/webgpu-wasm/matcher.wgsl");
    let src = std::fs::read_to_string(path).unwrap();
    assert!(src.is_ascii());
    validate(&src);
    for (wg, h, w) in [(64, 40, 48), (32, 8, 1), (1, 1, 90)] {
        let s = specialize(&src, &[("WG", wg), ("CELL_H", h), ("MAX_W", w)]);
        assert!(s.contains(&format!("const CELL_H: u32 = {h}u;")));
        validate(&s);
    }
}
