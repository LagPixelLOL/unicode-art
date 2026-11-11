//! Compute core of the unicode art generator.
//!
//! The pure Rust modules are usable (and tested) natively; `api` exposes
//! them to JavaScript through wasm-bindgen.

pub mod api;
pub mod bank;
pub mod charset;
pub mod compare;
pub mod font;
pub mod image;
pub mod layout;
