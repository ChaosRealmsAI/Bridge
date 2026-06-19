use super::*;

pub(crate) fn desktop_ui_html() -> String {
    include_str!("../ui/index.html")
        .replace(
            "__PANDA_BRIDGE_DESKTOP_CSS__",
            include_str!("../ui/styles.css"),
        )
        .replace("__PANDA_BRIDGE_DESKTOP_JS__", include_str!("../ui/app.js"))
}

pub(crate) fn run_window() -> Result<(), String> {
    let state = new_app_state();
    let initial_links = initial_deep_links();
    #[cfg(windows)]
    let windows_single_instance = match prepare_windows_single_instance(&initial_links)? {
        Some(instance) => instance,
        None => return Ok(()),
    };
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let ipc_proxy = proxy.clone();
    #[cfg(windows)]
    {
        windows_single_instance.start(proxy.clone());
        if should_register_windows_url_scheme_on_startup() {
            if let Err(error) = register_windows_url_scheme() {
                eprintln!("[windows] failed to register panda-bridge URL scheme: {error}");
            }
        }
    }
    if verify_control_enabled() {
        start_verify_control(state.clone(), proxy.clone())?;
    }
    #[allow(unused_mut)]
    let mut window_builder = WindowBuilder::new()
        .with_title("Bridge")
        .with_inner_size(LogicalSize::new(
            DESKTOP_WINDOW_WIDTH,
            DESKTOP_WINDOW_HEIGHT,
        ))
        .with_min_inner_size(LogicalSize::new(
            DESKTOP_WINDOW_WIDTH,
            DESKTOP_WINDOW_HEIGHT,
        ))
        .with_resizable(false);
    #[cfg(target_os = "macos")]
    {
        window_builder = window_builder.with_transparent(true);
    }
    #[cfg(windows)]
    {
        window_builder = window_builder.with_transparent(true);
    }
    let window = window_builder
        .build(&event_loop)
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    if let Err(error) = apply_vibrancy(
        &window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        None,
    ) {
        eprintln!("[vibrancy] failed to apply: {error}");
    }
    #[cfg(windows)]
    let windows_backdrop_enabled = apply_windows_backdrop(&window);
    let html = desktop_ui_html();
    #[allow(unused_mut)]
    let mut webview_builder =
        WebViewBuilder::new()
            .with_html(html)
            .with_ipc_handler(move |request| {
                let _ = ipc_proxy.send_event(UserEvent::Ipc(request.body().clone()));
            });
    #[cfg(target_os = "macos")]
    {
        webview_builder = webview_builder.with_transparent(true);
    }
    #[cfg(windows)]
    {
        if windows_backdrop_enabled {
            webview_builder = webview_builder.with_transparent(true);
        } else {
            webview_builder = webview_builder.with_background_color((245, 247, 250, 255));
        }
    }
    let webview = webview_builder
        .build(&window)
        .map_err(|error| error.to_string())?;

    let mut sent_initial_links = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) if !sent_initial_links => {
                sent_initial_links = true;
                // Center on the monitor the window opened on, then focus — keeps it
                // visible/centered on the user's active display (no off-screen / corner).
                if let Some(monitor) = window.current_monitor() {
                    let scale = monitor.scale_factor();
                    let area = monitor.size();
                    let origin = monitor.position();
                    let ww = (DESKTOP_WINDOW_WIDTH * scale).round() as i32;
                    let wh = (DESKTOP_WINDOW_HEIGHT * scale).round() as i32;
                    let x = origin.x + ((area.width as i32 - ww) / 2).max(0);
                    let y = origin.y + ((area.height as i32 - wh) / 2).max(0);
                    window.set_outer_position(tao::dpi::PhysicalPosition::new(x, y));
                }
                window.set_focus();
                if should_apply_launch_at_login_on_startup() {
                    let settings = load_settings_with_api(DEFAULT_API);
                    if let Err(error) = apply_launch_at_login(settings.launch_at_login) {
                        eprintln!("[launch-at-login] {error}");
                    }
                }
                if load_credentials().is_ok() {
                    let _ = start_worker(&state, proxy.clone());
                }
                if !initial_links.is_empty() {
                    foreground_window_for_deep_link(&window);
                }
                for link in &initial_links {
                    let _ = proxy.send_event(UserEvent::UiEvent(json!({
                        "type": "event",
                        "event": "deep_link",
                        "url": link
                    })));
                }
            }
            Event::Opened { urls } => {
                if !urls.is_empty() {
                    foreground_window_for_deep_link(&window);
                }
                for url in urls {
                    let _ = proxy.send_event(UserEvent::UiEvent(json!({
                        "type": "event",
                        "event": "deep_link",
                        "url": url.to_string()
                    })));
                }
            }
            Event::UserEvent(UserEvent::Ipc(raw)) => {
                handle_ipc(raw, state.clone(), proxy.clone());
            }
            Event::UserEvent(UserEvent::Respond { id, ok, payload }) => {
                let message = if ok {
                    json!({ "type": "response", "id": id, "ok": true, "result": payload })
                } else {
                    json!({ "type": "response", "id": id, "ok": false, "error": payload.as_str().unwrap_or("desktop command failed") })
                };
                let _ = webview.evaluate_script(&format!("window.PandaBridge.receive({});", message));
            }
            Event::UserEvent(UserEvent::UiEvent(message)) => {
                if message.get("event").and_then(Value::as_str) == Some("deep_link") {
                    foreground_window_for_deep_link(&window);
                }
                let _ = webview.evaluate_script(&format!("window.PandaBridge.receive({});", message));
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                state.worker_running.store(false, Ordering::SeqCst);
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

pub(crate) fn foreground_window_for_deep_link(window: &tao::window::Window) {
    window.set_visible(true);
    window.set_minimized(false);
    window.request_user_attention(Some(tao::window::UserAttentionType::Informational));
    window.set_focus();
}

#[cfg(windows)]
pub(crate) fn prepare_windows_single_instance(
    initial_links: &[String],
) -> Result<Option<WindowsSingleInstance>, String> {
    match TcpListener::bind(WINDOWS_SINGLE_INSTANCE_ADDR) {
        Ok(listener) => {
            let token = Arc::new(format!("pbw_{}_{}", std::process::id(), next_event_seq()));
            write_windows_single_instance_state(token.as_str())?;
            Ok(Some(WindowsSingleInstance { listener, token }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            forward_windows_deep_links(initial_links)?;
            Ok(None)
        }
        Err(error) => Err(format!(
            "failed to bind Windows single-instance listener on {WINDOWS_SINGLE_INSTANCE_ADDR}: {error}"
        )),
    }
}

#[cfg(windows)]
impl WindowsSingleInstance {
    fn start(self, proxy: EventLoopProxy<UserEvent>) {
        let token = self.token.clone();
        thread::spawn(move || {
            for incoming in self.listener.incoming() {
                match incoming {
                    Ok(stream) => {
                        let next_proxy = proxy.clone();
                        let next_token = token.clone();
                        thread::spawn(move || {
                            if let Err(error) =
                                handle_windows_instance_stream(stream, next_proxy, next_token)
                            {
                                eprintln!("[windows-single-instance] {error}");
                            }
                        });
                    }
                    Err(error) => eprintln!("[windows-single-instance] accept failed: {error}"),
                }
            }
        });
    }
}

#[cfg(windows)]
pub(crate) fn handle_windows_instance_stream(
    stream: TcpStream,
    proxy: EventLoopProxy<UserEvent>,
    token: Arc<String>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream);
    let mut raw = String::new();
    reader
        .read_line(&mut raw)
        .map_err(|error| error.to_string())?;
    let payload: Value = serde_json::from_str(raw.trim()).map_err(|error| error.to_string())?;
    if payload.get("token").and_then(Value::as_str) != Some(token.as_str()) {
        return Err("invalid forwarding token".to_string());
    }
    let links = payload
        .get("links")
        .and_then(Value::as_array)
        .ok_or("forwarded payload missing links")?;
    for link in links.iter().filter_map(Value::as_str) {
        let _ = proxy.send_event(UserEvent::UiEvent(json!({
            "type": "event",
            "event": "deep_link",
            "url": link
        })));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn forward_windows_deep_links(initial_links: &[String]) -> Result<(), String> {
    let state_text = fs::read_to_string(windows_single_instance_state_path()?)
        .map_err(|error| format!("single-instance state unavailable: {error}"))?;
    let state: WindowsSingleInstanceState = serde_json::from_str(&state_text)
        .map_err(|error| format!("invalid single-instance state: {error}"))?;
    let mut stream = TcpStream::connect(&state.addr).map_err(|error| {
        format!(
            "failed to connect to primary instance at {}: {error}",
            state.addr
        )
    })?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let payload = json!({
        "token": state.token,
        "links": initial_links
    });
    writeln!(stream, "{payload}").map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())
}

#[cfg(windows)]
pub(crate) fn write_windows_single_instance_state(token: &str) -> Result<(), String> {
    let state = WindowsSingleInstanceState {
        addr: WINDOWS_SINGLE_INSTANCE_ADDR.to_string(),
        token: token.to_string(),
        pid: std::process::id(),
        created_at: now_string(),
    };
    write_file(
        &windows_single_instance_state_path()?,
        &serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?,
    )
}

#[cfg(windows)]
pub(crate) fn windows_single_instance_state_path() -> Result<PathBuf, String> {
    Ok(state_dir()?.join(WINDOWS_SINGLE_INSTANCE_STATE_FILE))
}

#[cfg(windows)]
pub(crate) fn register_windows_url_scheme() -> Result<(), String> {
    let exe = env::current_exe().map_err(|error| error.to_string())?;
    let command = format!("\"{}\" \"%1\"", exe.to_string_lossy());
    let scheme = windows_registry::CURRENT_USER
        .create(r"Software\Classes\panda-bridge")
        .map_err(|error| error.to_string())?;
    scheme
        .set_string("", "URL:Panda Bridge Protocol")
        .map_err(|error| error.to_string())?;
    scheme
        .set_string("URL Protocol", "")
        .map_err(|error| error.to_string())?;
    let command_key = windows_registry::CURRENT_USER
        .create(r"Software\Classes\panda-bridge\shell\open\command")
        .map_err(|error| error.to_string())?;
    command_key
        .set_string("", command)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
pub(crate) fn apply_windows_backdrop(window: &tao::window::Window) -> bool {
    match apply_mica(window, Some(false)) {
        Ok(()) => true,
        Err(mica_error) => match apply_acrylic(window, Some((245, 247, 250, 180))) {
            Ok(()) => true,
            Err(acrylic_error) => {
                eprintln!(
                    "[vibrancy] Windows native backdrop unavailable; mica: {mica_error}; acrylic: {acrylic_error}"
                );
                false
            }
        },
    }
}
