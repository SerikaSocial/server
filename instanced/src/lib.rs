//! Relay internals, exposed as a library so integration tests (and later the bot load
//! harness) can drive the server directly. The binary in main.rs is a thin wrapper.

pub mod protocol;
pub mod server;
pub mod ticket;

pub use server::Server;
