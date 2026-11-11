//! All native tests of the compute core live in this single test binary so
//! the crate is only linked once.

mod bank;
mod charset;
mod compare;
mod font;
mod image;
mod layout;
mod reference;
mod shader;

use std::path::PathBuf;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

pub fn fixture(name: &str) -> Vec<u8> {
    let path = repo_root().join("tests/fixtures/fonts").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}
