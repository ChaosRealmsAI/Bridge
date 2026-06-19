use super::*;

pub(crate) fn launch_agent_plist(executable: &str) -> String {
    let escaped = executable
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n\
    <key>Label</key>\n\
    <string>cc.otherline.panda-bridge</string>\n\
    <key>ProgramArguments</key>\n\
    <array>\n\
        <string>{escaped}</string>\n\
    </array>\n\
    <key>RunAtLoad</key>\n\
    <true/>\n\
    <key>ProcessType</key>\n\
    <string>Interactive</string>\n\
</dict>\n\
</plist>"
    )
}

/// 开机自启（契约 §1 连接全自动）：macOS 写入 LaunchAgent，Windows 写入 HKCU Run。
pub(crate) fn apply_launch_at_login(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = home_dir()?.join("Library/LaunchAgents/cc.otherline.panda-bridge.plist");
        if !enabled {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
            return Ok(());
        }
        let exe = env::current_exe().map_err(|error| error.to_string())?;
        return write_external_state_file(&path, &launch_agent_plist(&exe.to_string_lossy()));
    }
    #[cfg(windows)]
    {
        return apply_windows_launch_at_login(enabled);
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = enabled;
        Ok(())
    }
}

#[cfg(windows)]
pub(crate) fn apply_windows_launch_at_login(enabled: bool) -> Result<(), String> {
    let run_key = windows_registry::CURRENT_USER
        .create(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .map_err(|error| error.to_string())?;
    if !enabled {
        let _ = run_key.remove_value("Panda Bridge");
        return Ok(());
    }
    let exe = env::current_exe().map_err(|error| error.to_string())?;
    run_key
        .set_string("Panda Bridge", windows_registry_command_for_exe(&exe))
        .map_err(|error| error.to_string())
}

#[cfg(any(windows, test))]
pub(crate) fn windows_registry_command_for_exe(exe: &Path) -> String {
    format!("\"{}\"", exe.to_string_lossy())
}

pub(crate) fn should_apply_launch_at_login_on_startup() -> bool {
    if cfg!(target_os = "macos") {
        return running_from_app_bundle();
    }
    if cfg!(target_os = "windows") {
        return !cfg!(debug_assertions) && !env_flag("PANDA_BRIDGE_DISABLE_STARTUP_APPLY");
    }
    false
}

#[cfg(windows)]
pub(crate) fn should_register_windows_url_scheme_on_startup() -> bool {
    !cfg!(debug_assertions) || env_flag("PANDA_BRIDGE_REGISTER_URL_SCHEME")
}

pub(crate) fn running_from_app_bundle() -> bool {
    env::current_exe()
        .map(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS"))
        .unwrap_or(false)
}
