use keyring::Entry;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tao::{
    dpi::LogicalSize,
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::WindowBuilder,
};
use tungstenite::{client::IntoClientRequest, connect, http::HeaderValue, Message};
#[cfg(windows)]
use window_vibrancy::{apply_acrylic, apply_mica};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
use wry::WebViewBuilder;

// Single process-wide lock serializing every test that mutates process-global
// env vars. Tests in different modules (main.rs, connector::fs, ...) share ONE
// lock so they never run concurrently and clobber each other's env (e.g.
// BRIDGE_FS_ALLOWED_ROOTS / BRIDGE_CAPTOKEN_*).
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

mod authorization;
pub(crate) use authorization::*;
mod catalog;
pub(crate) use catalog::*;
mod commands;
pub(crate) use commands::*;
mod headless;
pub(crate) use headless::*;
mod relay;
pub(crate) use relay::*;
mod settings;
pub(crate) use settings::*;
mod updates;
pub(crate) use updates::*;
mod verify;
pub(crate) use verify::*;
mod window;
pub(crate) use window::*;

include!("model_state.rs");

fn main() {
    if let Some(code) = run_headless_if_requested() {
        std::process::exit(code);
    }
    if let Err(error) = run_window() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

include!("tests.rs");
