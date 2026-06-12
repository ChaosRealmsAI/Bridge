use sha2::{Digest, Sha256};
use std::{
    fmt,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(target_os = "macos")]
pub mod macos;
pub mod noop;
pub mod profiles;

#[derive(Debug, Clone)]
pub struct SandboxSpec {
    pub profile: SandboxProfileKind,
    pub read_roots: Vec<PathBuf>,
    pub write_roots: Vec<PathBuf>,
    pub exec_allow: Vec<PathBuf>,
    pub allow_exec_subtree: bool,
    pub net: NetPolicy,
    pub limits: ResourceLimits,
    pub env_allow: Vec<(String, String)>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxProfileKind {
    CodexWorkspace,
    DataKvDir,
    FsReadDir,
    FsWriteDir,
    ShellCommand,
}

impl SandboxProfileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CodexWorkspace => "codex_workspace",
            Self::DataKvDir => "data_kv_dir",
            Self::FsReadDir => "fs_read_dir",
            Self::FsWriteDir => "fs_write_dir",
            Self::ShellCommand => "shell_command",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetPolicy {
    Deny,
    AllowOutbound,
}

impl NetPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::AllowOutbound => "allow_outbound",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    Enforce,
    Disabled,
}

pub fn mode() -> SandboxMode {
    #[cfg(debug_assertions)]
    {
        match std::env::var("PANDA_BRIDGE_SANDBOX_MODE") {
            Ok(value) if value.eq_ignore_ascii_case("disabled") && cfg!(target_os = "macos") => {
                SandboxMode::Disabled
            }
            _ => SandboxMode::Enforce,
        }
    }
    #[cfg(not(debug_assertions))]
    {
        SandboxMode::Enforce
    }
}

#[cfg(debug_assertions)]
pub fn disabled_for_debug() -> bool {
    mode() == SandboxMode::Disabled
}

#[cfg(not(debug_assertions))]
pub fn disabled_for_debug() -> bool {
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceLimits {
    pub cpu_seconds: u64,
    pub address_space: u64,
    pub open_files: u64,
    pub processes: u64,
    pub file_size: u64,
}

impl ResourceLimits {
    pub fn codex_default() -> Self {
        Self {
            cpu_seconds: 300,
            address_space: 4 * 1024 * 1024 * 1024,
            open_files: 512,
            processes: 64,
            file_size: 1024 * 1024 * 1024,
        }
    }

    pub fn data_default() -> Self {
        Self {
            cpu_seconds: 10,
            address_space: 512 * 1024 * 1024,
            open_files: 64,
            processes: 8,
            file_size: 64 * 1024 * 1024,
        }
    }

    pub fn fs_read_default() -> Self {
        Self {
            cpu_seconds: 10,
            address_space: 256 * 1024 * 1024,
            open_files: 32,
            processes: 2,
            file_size: 64 * 1024 * 1024,
        }
    }

    pub fn fs_write_default() -> Self {
        Self {
            cpu_seconds: 10,
            address_space: 256 * 1024 * 1024,
            open_files: 32,
            processes: 2,
            file_size: 64 * 1024 * 1024,
        }
    }

    pub fn shell_default() -> Self {
        Self {
            cpu_seconds: 30,
            address_space: 1024 * 1024 * 1024,
            open_files: 128,
            processes: 16,
            file_size: 64 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone)]
pub enum SandboxError {
    Unavailable { platform: String },
    ProfileRenderFailed { reason: String },
    ApplyFailed { reason: String },
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable { platform } => write!(f, "sandbox unavailable on {platform}"),
            Self::ProfileRenderFailed { reason } => {
                write!(f, "sandbox profile render failed: {reason}")
            }
            Self::ApplyFailed { reason } => write!(f, "sandbox apply failed: {reason}"),
        }
    }
}

impl std::error::Error for SandboxError {}

pub trait SandboxBackend: Send + Sync {
    fn name(&self) -> &'static str;
    fn available(&self) -> bool;
    fn wrap_command(&self, command: &mut Command, spec: &SandboxSpec) -> Result<(), SandboxError>;
    fn render_debug(&self, spec: &SandboxSpec) -> Result<String, SandboxError>;
}

pub fn backend() -> &'static dyn SandboxBackend {
    #[cfg(target_os = "macos")]
    {
        static BACKEND: macos::SeatbeltBackend = macos::SeatbeltBackend::new();
        &BACKEND
    }
    #[cfg(not(target_os = "macos"))]
    {
        static BACKEND: noop::UnavailableBackend = noop::UnavailableBackend;
        &BACKEND
    }
}

pub fn spec_fingerprint(spec: &SandboxSpec, product_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(product_id.as_bytes());
    hasher.update([0]);
    hasher.update(spec.profile.as_str().as_bytes());
    hasher.update([0]);
    hash_paths(&mut hasher, &spec.read_roots);
    hash_paths(&mut hasher, &spec.write_roots);
    hash_paths(&mut hasher, &spec.exec_allow);
    hasher.update(spec.net.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(spec.cwd.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(spec.limits.cpu_seconds.to_le_bytes());
    hasher.update(spec.limits.address_space.to_le_bytes());
    hasher.update(spec.limits.open_files.to_le_bytes());
    hasher.update(spec.limits.processes.to_le_bytes());
    hasher.update(spec.limits.file_size.to_le_bytes());
    let digest = hasher.finalize();
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hash_paths(hasher: &mut Sha256, paths: &[PathBuf]) {
    let mut items = paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    items.sort();
    for item in items {
        hasher.update(item.as_bytes());
        hasher.update([0]);
    }
}

pub fn canonical_existing_path(path: impl AsRef<Path>) -> Result<PathBuf, SandboxError> {
    std::fs::canonicalize(path.as_ref()).map_err(|error| SandboxError::ProfileRenderFailed {
        reason: format!("{}: {error}", path.as_ref().to_string_lossy()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::sandbox::noop::UnavailableBackend;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn unavailable_backend_fails_closed() {
        let backend = UnavailableBackend;
        let mut command = Command::new("codex");
        let spec = SandboxSpec {
            profile: SandboxProfileKind::CodexWorkspace,
            read_roots: vec![PathBuf::from("/tmp/ws")],
            write_roots: vec![PathBuf::from("/tmp/ws")],
            exec_allow: vec![PathBuf::from("/usr/bin/true")],
            allow_exec_subtree: false,
            net: NetPolicy::Deny,
            limits: ResourceLimits::codex_default(),
            env_allow: Vec::new(),
            cwd: PathBuf::from("/tmp/ws"),
        };
        assert!(!backend.available());
        let error = backend.wrap_command(&mut command, &spec).unwrap_err();
        assert!(matches!(error, SandboxError::Unavailable { .. }));
    }

    #[test]
    fn fingerprint_changes_with_product_or_boundary() {
        let base = SandboxSpec {
            profile: SandboxProfileKind::CodexWorkspace,
            read_roots: vec![PathBuf::from("/tmp/a")],
            write_roots: vec![PathBuf::from("/tmp/a")],
            exec_allow: vec![PathBuf::from("/usr/bin/true")],
            allow_exec_subtree: false,
            net: NetPolicy::Deny,
            limits: ResourceLimits::codex_default(),
            env_allow: Vec::new(),
            cwd: PathBuf::from("/tmp/a"),
        };
        let mut changed = base.clone();
        changed.net = NetPolicy::AllowOutbound;
        assert_eq!(spec_fingerprint(&base, "A"), spec_fingerprint(&base, "A"));
        assert_ne!(spec_fingerprint(&base, "A"), spec_fingerprint(&base, "B"));
        assert_ne!(
            spec_fingerprint(&base, "A"),
            spec_fingerprint(&changed, "A")
        );
    }

    #[test]
    fn sandbox_mode_defaults_to_enforce() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("PANDA_BRIDGE_SANDBOX_MODE");
        assert_eq!(mode(), SandboxMode::Enforce);
    }

    #[test]
    fn sandbox_mode_disabled_only_applies_on_macos() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("PANDA_BRIDGE_SANDBOX_MODE", "disabled");
        if cfg!(debug_assertions) && cfg!(target_os = "macos") {
            assert_eq!(mode(), SandboxMode::Disabled);
            assert!(disabled_for_debug());
        } else {
            assert_eq!(mode(), SandboxMode::Enforce);
            assert!(!disabled_for_debug());
        }
        std::env::remove_var("PANDA_BRIDGE_SANDBOX_MODE");
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn sandbox_mode_disabled_env_is_ignored_in_release() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("PANDA_BRIDGE_SANDBOX_MODE", "disabled");
        assert_eq!(mode(), SandboxMode::Enforce);
        assert!(!disabled_for_debug());
        std::env::remove_var("PANDA_BRIDGE_SANDBOX_MODE");
    }
}
