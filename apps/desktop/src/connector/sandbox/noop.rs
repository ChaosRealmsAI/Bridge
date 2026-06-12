use std::process::Command;

use super::{profiles, SandboxBackend, SandboxError, SandboxSpec};

pub struct UnavailableBackend;

impl SandboxBackend for UnavailableBackend {
    fn name(&self) -> &'static str {
        "unavailable"
    }

    fn available(&self) -> bool {
        false
    }

    fn wrap_command(
        &self,
        _command: &mut Command,
        _spec: &SandboxSpec,
    ) -> Result<(), SandboxError> {
        Err(SandboxError::Unavailable {
            platform: std::env::consts::OS.to_string(),
        })
    }

    fn render_debug(&self, spec: &SandboxSpec) -> Result<String, SandboxError> {
        profiles::render(spec)
    }
}
