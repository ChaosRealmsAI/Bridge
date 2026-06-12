use libc::{c_char, c_int};
use std::{ffi::CString, io, os::unix::process::CommandExt, process::Command, ptr};

use super::{profiles, ResourceLimits, SandboxBackend, SandboxError, SandboxSpec};

pub struct SeatbeltBackend;

impl SeatbeltBackend {
    pub const fn new() -> Self {
        Self
    }
}

impl SandboxBackend for SeatbeltBackend {
    fn name(&self) -> &'static str {
        "macos-seatbelt"
    }

    fn available(&self) -> bool {
        true
    }

    fn wrap_command(&self, command: &mut Command, spec: &SandboxSpec) -> Result<(), SandboxError> {
        let profile = profiles::render(spec)?;
        let profile_c =
            CString::new(profile).map_err(|error| SandboxError::ProfileRenderFailed {
                reason: error.to_string(),
            })?;
        let limits = adjusted_limits(spec.limits);
        unsafe {
            command.pre_exec(move || {
                apply_limits(limits)?;
                apply_sandbox(profile_c.as_ptr())?;
                Ok(())
            });
        }
        Ok(())
    }

    fn render_debug(&self, spec: &SandboxSpec) -> Result<String, SandboxError> {
        profiles::render(spec)
    }
}

fn apply_limits(limits: ResourceLimits) -> io::Result<()> {
    set_limit(libc::RLIMIT_CPU, limits.cpu_seconds)?;
    if let Err(error) = set_limit(libc::RLIMIT_AS, limits.address_space) {
        if error.raw_os_error() != Some(libc::EINVAL) {
            return Err(error);
        }
    }
    set_limit(libc::RLIMIT_NOFILE, limits.open_files)?;
    set_limit(libc::RLIMIT_NPROC, limits.processes)?;
    set_limit(libc::RLIMIT_FSIZE, limits.file_size)?;
    Ok(())
}

fn adjusted_limits(mut limits: ResourceLimits) -> ResourceLimits {
    // macOS RLIMIT_NPROC is per real UID, not per sandboxed process tree. A
    // literal low value such as 16 would fail immediately on a normal desktop
    // account that already owns more than 16 processes. Treat the configured
    // value as the allowed additional process budget for this sandboxed tree.
    if let Some(current) = current_process_count() {
        limits.processes = current.saturating_add(limits.processes);
    }
    limits
}

fn current_process_count() -> Option<u64> {
    const PROC_ALL_PIDS: u32 = 1;
    let bytes = unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, ptr::null_mut(), 0) };
    if bytes <= 0 {
        return None;
    }
    let count = (bytes as usize) / std::mem::size_of::<libc::pid_t>();
    Some(count as u64)
}

fn set_limit(resource: libc::c_int, value: u64) -> io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: value as libc::rlim_t,
        rlim_max: value as libc::rlim_t,
    };
    let rc = unsafe { libc::setrlimit(resource, &limit) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn apply_sandbox(profile: *const c_char) -> io::Result<()> {
    let mut error_buf: *mut c_char = ptr::null_mut();
    let rc = unsafe { sandbox_init(profile, 0, &mut error_buf) };
    if rc == 0 {
        return Ok(());
    }
    if !error_buf.is_null() {
        unsafe { sandbox_free_error(error_buf) };
    }
    Err(io::Error::last_os_error())
}

#[link(name = "System")]
extern "C" {
    fn sandbox_init(profile: *const c_char, flags: u64, errorbuf: *mut *mut c_char) -> c_int;
    fn sandbox_free_error(errorbuf: *mut c_char);
}
