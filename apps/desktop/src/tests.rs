#[cfg(test)]
mod tests {
    use super::*;

    use crate::TEST_ENV_LOCK as ENV_LOCK;

    fn test_credentials(capabilities: Vec<&str>) -> Credentials {
        Credentials {
            api_base: "http://local.test".to_string(),
            device_id: "dev_1".to_string(),
            device_name: "Device".to_string(),
            device_token: "pbd_test".to_string(),
            install_id: None,
            account_id: Some("user_1".to_string()),
            account_display: Some("user@example.test".to_string()),
            product_id: Some("bridge-demo".to_string()),
            product_name: Some("Bridge Demo".to_string()),
            cloud_origin: Some("http://local.test".to_string()),
            authorized_products: vec![ProductGrant {
                id: "bridge-demo".to_string(),
                name: "Bridge Demo".to_string(),
                origin: Some("http://local.test".to_string()),
                authorization: AuthorizationState::Active,
                capabilities: capabilities.into_iter().map(ToOwned::to_owned).collect(),
                policy: test_auth_scope(),
                epoch: 1,
                accounts: Vec::new(),
                local_roots: LocalRootBindings::default(),
                authorized_at: now_string(),
            }],
            device_token_expires_at: None,
            device_token_rotated_at_unix: None,
            install_identity_bound: None,
            device_online: None,
            device_last_seen_at: None,
            connections: Vec::new(),
            claimed_at: now_string(),
        }
    }

    fn reset_credentials_env() {
        env::remove_var("PANDA_BRIDGE_DESKTOP_STATE");
        env::remove_var("PANDA_BRIDGE_DESKTOP_STATE_DIR");
        env::remove_var("PANDA_BRIDGE_USE_KEYCHAIN");
        env::remove_var("PANDA_BRIDGE_SKIP_KEYCHAIN");
        env::remove_var("PANDA_BRIDGE_SKIP_REMOTE_REVOKE");
    }

    #[test]
    fn adapter_bootstrap_payload_includes_product_authorization_mirror() {
        let credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        let mut product = credentials.authorized_products[0].clone();
        product.policy["product_authorization"] = json!({
            "owner": "bridge-demo",
            "enforcement": "acme-product-adapter",
            "control": "computer-control"
        });
        product.local_roots.fs_roots.insert(
            "default".to_string(),
            LocalRootBinding {
                real_path: "/tmp/acme-chat".to_string(),
                path_display: "[local]/default".to_string(),
                bound_at: now_string(),
                bound_device_id: credentials.device_id.clone(),
            },
        );
        let bootstrap = json!({
            "status": "ready",
            "product_id": product.id,
            "device_id": credentials.device_id,
            "authorization_id": "auth_1",
            "authorization_epoch": "7",
            "key_id": "rkx_1",
            "wrapped_key": {
                "algorithm": "ECDH-P256+A256GCM"
            }
        });

        let payload = adapter_relay_key_bootstrap_payload(&bootstrap, &product, &credentials);
        let mirror = payload
            .get("authorization_mirror")
            .expect("authorization mirror missing");

        assert_eq!(mirror["status"], json!("active"));
        assert_eq!(mirror["product_id"], json!("bridge-demo"));
        assert_eq!(
            mirror["authorization_context"],
            json!({
                "product_id": "bridge-demo",
                "device_id": "dev_1",
                "authorization_id": "auth_1",
                "authorization_epoch": "7",
                "relay_key_id": "rkx_1"
            })
        );
        assert_eq!(
            mirror["product_authorization"]["control"],
            "computer-control"
        );
        assert!(mirror["product_authorization"]
            .get("capabilities")
            .is_none());
        assert!(mirror["product_authorization"].get("roots").is_none());
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("pbd_test"));
    }

    fn restore_env_var(key: &str, value: Option<std::ffi::OsString>) {
        if let Some(value) = value {
            env::set_var(key, value);
        } else {
            env::remove_var(key);
        }
    }

    #[test]
    fn credentials_default_to_private_fallback_file_without_keychain() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::set_var("PANDA_BRIDGE_SKIP_KEYCHAIN", "1");
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        let home = env::temp_dir().join(format!(
            "panda-bridge-credentials-test-{}-{}",
            std::process::id(),
            unix_seconds()
        ));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        env::set_var("HOME", &home);
        env::remove_var("USERPROFILE");

        let credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        save_credentials(&credentials).unwrap();
        let path = fallback_credentials_path().unwrap();
        assert!(
            path.exists(),
            "credentials should be written to the private fallback file"
        );
        assert!(
            !path.starts_with(home.join(".panda-bridge")),
            "new credentials writes must use the platform app data state directory"
        );
        #[cfg(target_os = "macos")]
        assert!(
            path.ends_with("Library/Application Support/Panda Bridge/state/desktop-connector.json")
        );
        #[cfg(unix)]
        {
            let dir_mode = fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                dir_mode, 0o700,
                "fallback state directory should be private"
            );
            assert_eq!(file_mode, 0o600, "fallback state file should be private");
        }
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"device_token\""));
        let loaded = load_credentials().unwrap();
        assert_eq!(loaded.device_id, credentials.device_id);
        assert_eq!(loaded.device_token, credentials.device_token);

        delete_credentials().unwrap();
        assert!(
            !path.exists(),
            "delete should remove the fallback state file"
        );

        if let Some(value) = old_home {
            env::set_var("HOME", value);
        } else {
            env::remove_var("HOME");
        }
        if let Some(value) = old_userprofile {
            env::set_var("USERPROFILE", value);
        } else {
            env::remove_var("USERPROFILE");
        }
        reset_credentials_env();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn credentials_migrate_legacy_hidden_home_state_to_app_data() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::set_var("PANDA_BRIDGE_SKIP_KEYCHAIN", "1");
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        let home = env::temp_dir().join(format!(
            "panda-bridge-legacy-credentials-test-{}-{}",
            std::process::id(),
            unix_seconds()
        ));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".panda-bridge")).unwrap();
        env::set_var("HOME", &home);
        env::remove_var("USERPROFILE");

        let credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        fs::write(
            home.join(".panda-bridge/desktop-connector.json"),
            serde_json::to_string_pretty(&credentials).unwrap(),
        )
        .unwrap();

        let loaded = load_credentials().unwrap();
        assert_eq!(loaded.device_id, credentials.device_id);
        let migrated_path = fallback_credentials_path().unwrap();
        assert!(migrated_path.exists());
        assert!(!migrated_path.starts_with(home.join(".panda-bridge")));

        restore_env_var("HOME", old_home);
        restore_env_var("USERPROFILE", old_userprofile);
        reset_credentials_env();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn keychain_default_depends_on_build_and_env_overrides() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::remove_var("PANDA_BRIDGE_USE_KEYCHAIN");
        // Default: dev/debug builds use the file store (no per-launch keychain prompt);
        // release builds (signed + notarized) use the keychain.
        assert_eq!(
            keychain_enabled(),
            !cfg!(debug_assertions),
            "default keychain state should follow build profile"
        );
        env::set_var("PANDA_BRIDGE_USE_KEYCHAIN", "1");
        assert!(
            keychain_enabled(),
            "USE_KEYCHAIN should opt into the keychain"
        );
        env::set_var("PANDA_BRIDGE_SKIP_KEYCHAIN", "1");
        assert!(!keychain_enabled(), "SKIP_KEYCHAIN should take precedence");
        env::remove_var("PANDA_BRIDGE_USE_KEYCHAIN");
        reset_credentials_env();
    }

    #[cfg(unix)]
    #[test]
    fn explicit_desktop_state_does_not_chmod_external_parent() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let dir = env::temp_dir().join(format!(
            "panda-bridge-external-state-test-{}-{}",
            std::process::id(),
            unix_seconds()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let state = dir.join("desktop-state.json");
        env::set_var("PANDA_BRIDGE_DESKTOP_STATE", &state);

        save_credentials(&test_credentials(vec!["relay.envelope", "relay.ack"])).unwrap();

        let parent_mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(&state).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            parent_mode, 0o755,
            "external parent permissions must be left alone"
        );
        assert_eq!(
            file_mode, 0o600,
            "external state file should still be private"
        );

        reset_credentials_env();
        let _ = fs::remove_dir_all(&dir);
    }

    fn test_auth_scope() -> Value {
        json!({
            "version": "BRIDGE-RELAY-AUTH-v1",
            "request_source": "test_relay_scope",
            "product_id": "bridge-demo",
            "source_origin": "http://local.test",
            "capabilities": ["relay.envelope", "relay.ack"],
            "product_authorization": {
                "owner": "product-adapter",
                "enforcement": "product-adapter",
                "control": "computer-control"
            }
        })
    }

    fn with_settings_home(name: &str) -> PathBuf {
        let home = env::temp_dir().join(format!("{name}-{}", next_event_seq()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".panda-bridge")).unwrap();
        env::set_var("HOME", &home);
        env::remove_var("USERPROFILE");
        home
    }

    fn start_profile_server(diagnostics: Value) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let api = format!("http://{addr}");
        let handle = thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                let _ = reader.read_line(&mut request_line);
                loop {
                    let mut line = String::new();
                    let bytes = reader.read_line(&mut line).unwrap_or(0);
                    if bytes == 0 || line == "\r\n" || line == "\n" {
                        break;
                    }
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");
                let payload = if path == "/v1/health" {
                    json!({
                        "ok": true,
                        "protocol": BRIDGE_PROTOCOL_VERSION,
                        "env": "test",
                        "storage": "memory"
                    })
                } else {
                    diagnostics.clone()
                };
                write_http_json(&mut stream, 200, payload).unwrap();
            }
        });
        (api, handle)
    }

    #[test]
    fn cloud_profile_migrates_old_api_base_and_keeps_official_profile() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        let home = with_settings_home("panda-bridge-settings-migration");
        let api = "http://local.test:8787";
        fs::write(
            home.join(".panda-bridge/desktop-settings.json"),
            serde_json::to_string_pretty(&json!({
                "launch_at_login": true,
                "appearance": "auto",
                "language": "auto",
                "api_base": api
            }))
            .unwrap(),
        )
        .unwrap();

        let settings = load_settings_with_api(api);

        assert_eq!(settings.api_base, api);
        assert!(!settings_path()
            .unwrap()
            .starts_with(home.join(".panda-bridge")));
        assert_eq!(settings.selected_cloud_profile_id, profile_id_for_api(api));
        assert!(settings
            .cloud_profiles
            .iter()
            .any(|profile| profile.id == "official" && profile.api_base == DEFAULT_API));
        assert!(settings
            .cloud_profiles
            .iter()
            .any(|profile| profile.api_base == api && profile.source == "user"));

        restore_env_var("HOME", old_home);
        restore_env_var("USERPROFILE", old_userprofile);
        reset_credentials_env();
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn normalize_settings_rewrites_stale_server_profile_products() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let api = "http://local.test:8787";
        let mut settings = default_settings();
        settings.cloud_profiles.push(CloudProfile {
            id: profile_id_for_api(api),
            name: "My Server".to_string(),
            api_base: api.to_string(),
            web_origin: Some(api.to_string()),
            products: vec![DesktopProductCatalogEntry {
                id: "acme-demo".to_string(),
                name: "Acme Demo".to_string(),
                origin: Some(api.to_string()),
                web_url: Some(format!("{api}/acme")),
                official_origin: Some(api.to_string()),
                official_origins: vec![api.to_string()],
            }],
            source: "selfhost".to_string(),
            updated_at: now_string(),
        });
        settings.selected_cloud_profile_id = profile_id_for_api(api);

        normalize_settings(&mut settings, api);

        let profile = selected_cloud_profile(&settings).unwrap();
        assert_eq!(profile.api_base, api);
        assert!(profile
            .products
            .iter()
            .any(|product| product.id == "panda-burn"));
        assert!(!profile
            .products
            .iter()
            .any(|product| product.id == "acme-demo"));
        reset_credentials_env();
    }

    #[test]
    fn add_cloud_profile_rejects_invalid_diagnostics_without_saving() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        let home = with_settings_home("panda-bridge-invalid-profile");
        let (api, server) = start_profile_server(json!({
            "ok": true,
            "protocol": "not-bridge",
            "api_base": "http://127.0.0.1:1",
            "web_origin": "http://127.0.0.1:1",
            "products": []
        }));

        let error = add_cloud_profile(&json!({ "api": api })).unwrap_err();
        assert!(error.contains("unsupported protocol"));
        server.join().unwrap();
        let settings = load_settings_with_api(DEFAULT_API);
        assert_eq!(settings.selected_cloud_profile_id, "official");
        assert_eq!(settings.cloud_profiles.len(), 1);

        restore_env_var("HOME", old_home);
        restore_env_var("USERPROFILE", old_userprofile);
        reset_credentials_env();
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn diagnostics_product_without_web_url_uses_origin_fallback() {
        let product = ProductInfo {
            id: "acme-demo".to_string(),
            name: "Acme Demo".to_string(),
            origin: Some("http://local.test".to_string()),
            official_origin: None,
            official_origins: Vec::new(),
            web_url: None,
            capabilities: vec!["relay.envelope".to_string(), "relay.ack".to_string()],
        };

        validate_bridge_product(&product).unwrap();
        let entry = product_entry_from_info(&product, "http://api.test");

        assert_eq!(entry.web_url.as_deref(), Some("http://local.test"));
    }

    #[test]
    fn diagnostics_product_accepts_authorize_web_url_query() {
        let product = ProductInfo {
            id: "acme-demo".to_string(),
            name: "Acme Demo".to_string(),
            origin: Some("https://acme.example.test".to_string()),
            official_origin: None,
            official_origins: Vec::new(),
            web_url: Some(
                "https://acme.example.test/authorize?source=bridge&product=acme-demo".to_string(),
            ),
            capabilities: vec!["relay.envelope".to_string(), "relay.ack".to_string()],
        };

        validate_bridge_product(&product).unwrap();
        let entry = product_entry_from_info(&product, "https://api.bridge.test.example");

        assert_eq!(
            entry.web_url.as_deref(),
            Some("https://acme.example.test/authorize?source=bridge&product=acme-demo"),
        );
    }

    #[test]
    fn diagnostics_product_rejects_unknown_capability() {
        let product = ProductInfo {
            id: "acme-demo".to_string(),
            name: "Acme Demo".to_string(),
            origin: Some("http://local.test".to_string()),
            official_origin: None,
            official_origins: Vec::new(),
            web_url: None,
            capabilities: vec![
                "relay.envelope".to_string(),
                "relay.ack".to_string(),
                "shell.run".to_string(),
            ],
        };

        let error = validate_bridge_product(&product).unwrap_err();
        assert!(error.contains("unsupported product capabilities"));
    }

    #[test]
    fn official_cloud_profile_cannot_be_removed() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let error = remove_cloud_profile(&json!({ "profile_id": "official" })).unwrap_err();
        assert!(error.contains("cannot be removed"));
        reset_credentials_env();
    }

    #[test]
    fn selfhost_profile_does_not_replace_fixed_product_catalog() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let api = "http://local.test:8787";
        let state = new_app_state();
        let mut settings = default_settings();
        let profile = CloudProfile {
            id: profile_id_for_api(api),
            name: "My Server".to_string(),
            api_base: api.to_string(),
            web_origin: Some(api.to_string()),
            products: vec![DesktopProductCatalogEntry {
                id: "acme-demo".to_string(),
                name: "Acme Demo".to_string(),
                origin: Some(api.to_string()),
                web_url: Some(format!("{api}/acme")),
                official_origin: Some(api.to_string()),
                official_origins: vec![api.to_string()],
            }],
            source: "selfhost".to_string(),
            updated_at: now_string(),
        };
        upsert_cloud_profile(&mut settings, profile, true);

        let products = desktop_products(None, &state, &settings);

        assert!(products.iter().any(|product| product.id == "panda-burn"));
        assert!(!products.iter().any(|product| product.id == "acme-demo"));
        reset_credentials_env();
    }

    #[test]
    fn open_web_uses_fixed_product_catalog_under_selected_server_profile() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        let home = with_settings_home("panda-bridge-open-web-profile");
        let api = "http://local.test:8787";
        let mut settings = default_settings();
        let profile = CloudProfile {
            id: profile_id_for_api(api),
            name: "Local Acme".to_string(),
            api_base: api.to_string(),
            web_origin: Some(api.to_string()),
            products: vec![DesktopProductCatalogEntry {
                id: "acme-demo".to_string(),
                name: "Acme Demo".to_string(),
                origin: Some(api.to_string()),
                web_url: Some(format!("{api}/acme")),
                official_origin: Some(api.to_string()),
                official_origins: vec![api.to_string()],
            }],
            source: "user".to_string(),
            updated_at: now_string(),
        };
        upsert_cloud_profile(&mut settings, profile, true);
        save_settings(&settings).unwrap();

        let url = open_web_url(&json!({ "product_id": "panda-burn" }));

        assert_eq!(url, "https://token-burn.com/authorize");
        restore_env_var("HOME", old_home);
        restore_env_var("USERPROFILE", old_userprofile);
        reset_credentials_env();
        let _ = fs::remove_dir_all(home);
    }

    fn test_pending_intent_claim() -> PendingIntentClaim {
        let policy = json!({
            "version": "BRIDGE-RELAY-AUTH-v1",
            "product_id": "acme-chat",
            "source_origin": "https://acme.example",
            "capabilities": ["relay.envelope", "relay.ack"],
            "product_authorization": {
                "owner": "acme-product-adapter",
                "enforcement": "acme-product-adapter",
                "control": "computer-control"
            }
        });
        PendingIntentClaim {
            api_base: "http://local.test".to_string(),
            intent: "intent_secret_token".to_string(),
            device_token: "pbd_secret_device_token".to_string(),
            token_expires_at: Some("2099-01-01T00:00:00Z".to_string()),
            install_id: "install_1".to_string(),
            install_identity_bound: Some(true),
            device: Device {
                id: "dev_1".to_string(),
                device_name: "Device".to_string(),
            },
            account: Some(ConnectUser {
                id: Some("user_1".to_string()),
                display_name: None,
                email: Some("user@example.test".to_string()),
            }),
            product: Some(ProductInfo {
                id: "acme-chat".to_string(),
                name: "Acme Chat".to_string(),
                origin: Some("https://acme.example".to_string()),
                official_origin: None,
                official_origins: Vec::new(),
                web_url: Some("https://acme.example/authorize".to_string()),
                capabilities: vec!["relay.envelope".to_string(), "relay.ack".to_string()],
            }),
            authorization: Some(AuthorizationInfo {
                status: Some(AuthorizationState::Pending),
                policy: policy.clone(),
                source_origin: Some("https://acme.example".to_string()),
                epoch: 1,
            }),
            devices: None,
            preview: IntentPreview {
                product_id: "acme-chat".to_string(),
                product_name: "Acme Chat".to_string(),
                cloud_origin: "https://acme.example".to_string(),
                capabilities: vec!["relay.envelope".to_string(), "relay.ack".to_string()],
                local_policy: policy,
                device_name: "Panda Bridge Desktop".to_string(),
                user_id: Some("user_1".to_string()),
                user_display_name: "user@example.test".to_string(),
                expires_at: "2099-01-01T00:00:00Z".to_string(),
                confirmation_mode: "confirm".to_string(),
            },
        }
    }

    #[test]
    fn pending_claim_public_value_exposes_preview_without_device_token() {
        let pending = test_pending_intent_claim();
        let public = pending_claim_public_value(&pending);
        assert_eq!(public["status"], "pending");
        assert_eq!(
            public["policy_capabilities"],
            json!(["relay.envelope", "relay.ack"])
        );
        assert_eq!(
            public["product_authorization"]["owner"],
            "acme-product-adapter"
        );
        assert_eq!(
            public["product_authorization"]["control"],
            "computer-control"
        );
        assert!(public["product_authorization"]
            .get("capabilities")
            .is_none());
        assert!(public["product_authorization"].get("roots").is_none());
        assert_eq!(
            public["authorization"]["source_origin"],
            "https://acme.example"
        );
        let text = serde_json::to_string(&public).unwrap();
        assert!(!text.contains("pbd_secret_device_token"));
        assert!(!text.contains("intent_secret_token"));
        assert!(text.contains("product_authorization"));
    }

    #[test]
    fn pending_claim_public_value_prefers_policy_display_product() {
        let mut pending = test_pending_intent_claim();
        if let Some(authorization) = pending.authorization.as_mut() {
            authorization.policy["display"] = json!({ "product": "Burn" });
        }
        pending.preview.local_policy["display"] = json!({ "product": "Burn" });

        let public = pending_claim_public_value(&pending);

        assert_eq!(public["product"]["name"], "Burn");
        let rows = pending_authorization_screenshot_rows(&public);
        assert!(rows.iter().any(|row| row == "PRODUCT: Burn (acme-chat)"));
    }

    fn test_credentials_for_device(
        device_id: &str,
        account_id: &str,
        display: &str,
    ) -> Credentials {
        let mut credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        credentials.device_id = device_id.to_string();
        credentials.device_name = format!("Device {device_id}");
        credentials.account_id = Some(account_id.to_string());
        credentials.account_display = Some(display.to_string());
        credentials
    }

    #[test]
    fn cloud_devices_cleanup_removes_stale_connections_for_account() {
        let mut connections = vec![
            test_credentials_for_device("dev_keep", "user_1", "user@example.test"),
            test_credentials_for_device("dev_stale", "user_1", "user@example.test"),
            test_credentials_for_device("dev_other", "user_2", "other@example.test"),
        ];
        let changed = apply_cloud_devices_to_connections(
            &mut connections,
            "http://local.test",
            Some("user_1"),
            Some(&[CloudDevice {
                id: "dev_keep".to_string(),
                name: Some("Current Mac".to_string()),
                online: Some(true),
                last_seen_at: Some("2026-06-11T00:00:00Z".to_string()),
            }]),
        );
        assert!(changed);
        assert_eq!(connections.len(), 2);
        assert!(connections.iter().any(|item| item.device_id == "dev_keep"));
        assert!(!connections.iter().any(|item| item.device_id == "dev_stale"));
        let kept = connections
            .iter()
            .find(|item| item.device_id == "dev_keep")
            .unwrap();
        assert_eq!(kept.device_name, "Current Mac");
        assert_eq!(kept.device_online, Some(true));
        assert_eq!(
            kept.device_last_seen_at.as_deref(),
            Some("2026-06-11T00:00:00Z")
        );
        assert!(connections.iter().any(|item| item.device_id == "dev_other"));
    }

    #[test]
    fn cloud_devices_cleanup_skips_when_response_has_no_devices() {
        let mut connections = vec![
            test_credentials_for_device("dev_keep", "user_1", "user@example.test"),
            test_credentials_for_device("dev_stale", "user_1", "user@example.test"),
        ];
        let changed = apply_cloud_devices_to_connections(
            &mut connections,
            "http://local.test",
            Some("user_1"),
            None,
        );
        assert!(!changed);
        assert_eq!(connections.len(), 2);
    }

    #[test]
    fn aggregate_products_dedupes_accounts_and_keeps_device_rows() {
        let mut one = test_credentials_for_device("dev_1", "user_1", "user@example.test");
        one.device_online = Some(true);
        one.device_last_seen_at = Some("2026-06-11T00:00:00Z".to_string());
        let mut two = test_credentials_for_device("dev_2", "user_1", "user@example.test");
        two.device_online = Some(false);
        let products = aggregate_authorized_products(&[one, two]);
        assert_eq!(products.len(), 1);
        assert_eq!(products[0].accounts.len(), 1);
        assert_eq!(products[0].accounts[0].devices.len(), 2);
        assert!(products[0].accounts[0]
            .devices
            .iter()
            .any(|item| item.id == "dev_1" && item.online == Some(true)));
        assert!(products[0].accounts[0]
            .devices
            .iter()
            .any(|item| item.id == "dev_2" && item.online == Some(false)));
    }

    #[test]
    fn authorization_toggle_pauses_and_restores_account_product() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let state_path = env::temp_dir().join(format!(
            "panda-bridge-toggle-test-{}.json",
            next_event_seq()
        ));
        env::set_var("PANDA_BRIDGE_DESKTOP_STATE", &state_path);
        let credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        save_credentials(&credentials).unwrap();

        let paused = toggle_authorization("bridge-demo", "user@example.test").unwrap();
        assert_eq!(paused["authorized"], "paused");
        let loaded = load_credentials().unwrap();
        assert_eq!(
            loaded.connections[0].authorized_products[0].authorization,
            AuthorizationState::Paused
        );
        assert!(authorized_connections(&loaded).is_empty());

        let restored = toggle_authorization("bridge-demo", "user@example.test").unwrap();
        assert_eq!(restored["authorized"], "active");
        let loaded = load_credentials().unwrap();
        assert_eq!(
            loaded.connections[0].authorized_products[0].authorization,
            AuthorizationState::Active
        );
        assert_eq!(authorized_connections(&loaded).len(), 1);

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
    }

    #[test]
    fn remove_authorization_deletes_local_account_product() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let state_path = env::temp_dir().join(format!(
            "panda-bridge-remove-test-{}.json",
            next_event_seq()
        ));
        env::set_var("PANDA_BRIDGE_DESKTOP_STATE", &state_path);
        env::set_var("PANDA_BRIDGE_SKIP_REMOTE_REVOKE", "1");
        let mut credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        credentials.api_base = "http://127.0.0.1:9".to_string();
        save_credentials(&credentials).unwrap();

        let removed = revoke_authorization("bridge-demo", Some("user@example.test"), None).unwrap();
        assert_eq!(removed["ok"], true);
        let loaded = load_credentials().unwrap();
        assert!(credentials_products(&loaded).is_empty());

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
    }

    #[test]
    fn update_settings_persists_switches_and_manages_launch_agent() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::set_var("PANDA_BRIDGE_SKIP_KEYCHAIN", "1");
        let old_home = env::var_os("HOME");
        let home = env::temp_dir().join(format!("panda-bridge-settings-test-{}", next_event_seq()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        env::set_var("HOME", &home);

        let updated = update_settings(&json!({
            "launch_at_login": true,
            "appearance": "dark",
            "language": "ja"
        }))
        .unwrap();
        assert!(updated.launch_at_login);
        assert_eq!(updated.appearance, "dark");
        assert_eq!(updated.language, "ja");
        let reloaded = load_settings_with_api(DEFAULT_API);
        assert!(reloaded.launch_at_login);
        assert_eq!(reloaded.appearance, "dark");
        assert_eq!(reloaded.language, "ja");
        assert_eq!(reloaded.api_base, DEFAULT_API);
        #[cfg(target_os = "macos")]
        {
            let plist = home.join("Library/LaunchAgents/cc.otherline.panda-bridge.plist");
            assert!(
                plist.exists(),
                "enabling launch_at_login should write the LaunchAgent"
            );
            let text = fs::read_to_string(&plist).unwrap();
            assert!(text.contains("cc.otherline.panda-bridge"));
            assert!(text.contains("<key>RunAtLoad</key>"));
        }

        let updated = update_settings(&json!({ "launch_at_login": false })).unwrap();
        assert!(!updated.launch_at_login);
        #[cfg(target_os = "macos")]
        {
            let plist = home.join("Library/LaunchAgents/cc.otherline.panda-bridge.plist");
            assert!(
                !plist.exists(),
                "disabling launch_at_login should remove the LaunchAgent"
            );
        }

        assert!(update_settings(&json!({ "appearance": "neon" })).is_err());
        assert!(update_settings(&json!({ "language": "fr" })).is_err());
        assert!(launch_agent_plist("/Apps/A&B.app/Contents/MacOS/pb").contains("A&amp;B.app"));
        assert_eq!(
            windows_registry_command_for_exe(Path::new(
                r"C:\Users\Ada Lovelace\AppData\Local\Panda Bridge\PandaBridge.exe"
            )),
            r#""C:\Users\Ada Lovelace\AppData\Local\Panda Bridge\PandaBridge.exe""#
        );

        if let Some(value) = old_home {
            env::set_var("HOME", value);
        } else {
            env::remove_var("HOME");
        }
        reset_credentials_env();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn reconnect_backoff_uses_exponential_delays_and_reset() {
        let mut backoff = ReconnectBackoff {
            attempt: 0,
            base_ms: 1_000,
            max_ms: 8_000,
        };
        assert_eq!(backoff.next_delay_ms(), 1_000);
        assert_eq!(backoff.next_delay_ms(), 2_000);
        assert_eq!(backoff.next_delay_ms(), 4_000);
        assert_eq!(backoff.next_delay_ms(), 8_000);
        assert_eq!(backoff.next_delay_ms(), 8_000);
        backoff.reset();
        assert_eq!(backoff.next_delay_ms(), 1_000);
    }

    #[test]
    fn status_serializes_account_level_dual_switches() {
        let mut credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        credentials.product_id = Some("panda-burn".to_string());
        credentials.product_name = Some("Burn".to_string());
        credentials.cloud_origin = Some("https://token-burn.com".to_string());
        credentials.authorized_products[0].id = "panda-burn".to_string();
        credentials.authorized_products[0].name = "Burn".to_string();
        credentials.authorized_products[0].origin = Some("https://token-burn.com".to_string());
        credentials.authorized_products[0].authorization = AuthorizationState::Paused;
        let state = new_app_state();
        state.worker_running.store(true, Ordering::SeqCst);
        state.realtime_connected.store(true, Ordering::SeqCst);

        let mut settings = default_settings();
        normalize_settings(&mut settings, &credentials.api_base);
        settings.selected_cloud_profile_id = profile_id_for_api(&credentials.api_base);
        let products = desktop_products(Some(&credentials), &state, &settings);
        let bridge_demo = products
            .iter()
            .find(|product| product.id == "panda-burn")
            .unwrap();
        assert_eq!(bridge_demo.accounts.len(), 1);
        assert_eq!(
            bridge_demo.accounts[0].authorized,
            AuthorizationState::Paused
        );
        assert!(!bridge_demo.accounts[0].connected);
        assert_eq!(bridge_demo.accounts[0].connection, "disabled");

        let serialized = serde_json::to_value(bridge_demo).unwrap();
        assert_eq!(serialized["accounts"][0]["authorized"], "paused");
        assert_eq!(serialized["accounts"][0]["connected"], false);

        credentials.authorized_products[0].authorization = AuthorizationState::Active;
        credentials.device_online = Some(true);
        let products = desktop_products(Some(&credentials), &state, &settings);
        let account = &products
            .iter()
            .find(|product| product.id == "panda-burn")
            .unwrap()
            .accounts[0];
        assert_eq!(account.authorized, AuthorizationState::Active);
        assert!(account.connected);
        assert_eq!(account.connection, "connected");
    }

    #[test]
    fn selected_profile_status_does_not_leak_global_realtime_or_device_presence() {
        let mut official = test_credentials(vec!["relay.envelope", "relay.ack"]);
        official.api_base = DEFAULT_API.to_string();
        official.device_id = "dev_official".to_string();
        official.device_token = "pbd_official".to_string();
        official.account_id = Some("official_user".to_string());
        official.account_display = Some("official@example.test".to_string());
        official.product_id = Some("panda-burn".to_string());
        official.product_name = Some("Burn".to_string());
        official.cloud_origin = Some("https://token-burn.com".to_string());
        official.authorized_products[0].id = "panda-burn".to_string();
        official.authorized_products[0].name = "Burn".to_string();
        official.authorized_products[0].origin = Some("https://token-burn.com".to_string());
        official.device_online = Some(true);

        let api = "http://selfhost.test:8787";
        let mut selected = official.clone();
        selected.api_base = api.to_string();
        selected.device_id = "dev_selfhost".to_string();
        selected.device_token = "pbd_selfhost".to_string();
        selected.account_id = Some("selfhost_user".to_string());
        selected.account_display = Some("selfhost@example.test".to_string());
        selected.device_online = Some(false);
        selected.device_last_seen_at = Some("2026-06-20T00:00:00Z".to_string());

        let credentials =
            credentials_from_connections(vec![official.clone(), selected.clone()], Some(&official), None);
        let mut settings = default_settings();
        upsert_cloud_profile(
            &mut settings,
            CloudProfile {
                id: profile_id_for_api(api),
                name: "My Server".to_string(),
                api_base: api.to_string(),
                web_origin: Some(api.to_string()),
                products: fixed_product_catalog_entries(),
                source: "selfhost".to_string(),
                updated_at: now_string(),
            },
            true,
        );
        let state = new_app_state();
        state.worker_running.store(true, Ordering::SeqCst);
        state.realtime_connected.store(true, Ordering::SeqCst);
        state
            .realtime_connection_keys
            .lock()
            .unwrap()
            .insert(realtime_connection_key(&official));

        let live = selected_profile_live_status(Some(&credentials), &state, &settings);

        assert_eq!(live.profile_id, profile_id_for_api(api));
        assert_eq!(live.api_base, api);
        assert_eq!(live.server.reachable, Some(true));
        assert_eq!(live.device.paired, true);
        assert_eq!(live.device.present, Some(false));
        assert_eq!(live.account.authorized, true);
        assert_eq!(live.transport.realtime_connected, false);
        assert_eq!(live.transport.realtime_state, "degraded");
        assert_eq!(live.transport.polling_state, "active");
    }

    #[test]
    fn official_profile_filters_legacy_authorization_grants() {
        let mut burn = test_credentials(vec!["relay.envelope", "relay.ack"]);
        burn.api_base = DEFAULT_API.to_string();
        burn.device_id = "dev_burn".to_string();
        burn.device_token = "pbd_burn".to_string();
        burn.account_id = Some("burn_user".to_string());
        burn.account_display = Some("burn@example.test".to_string());
        burn.product_id = Some("panda-burn".to_string());
        burn.product_name = Some("Burn".to_string());
        burn.cloud_origin = Some("https://token-burn.com".to_string());
        burn.authorized_products[0].id = "panda-burn".to_string();
        burn.authorized_products[0].name = "Burn".to_string();
        burn.authorized_products[0].origin = Some("https://token-burn.com".to_string());

        let mut legacy = test_credentials(vec!["relay.envelope", "relay.ack"]);
        legacy.api_base = DEFAULT_API.to_string();
        legacy.device_id = "dev_legacy".to_string();
        legacy.device_token = "pbd_legacy".to_string();
        legacy.account_id = Some("legacy_user".to_string());
        legacy.account_display = Some("legacy@example.test".to_string());
        legacy.product_id = Some("otherline".to_string());
        legacy.product_name = Some("Otherline".to_string());
        legacy.cloud_origin = Some("https://otherline.cc".to_string());
        legacy.authorized_products[0].id = "otherline".to_string();
        legacy.authorized_products[0].name = "Otherline".to_string();
        legacy.authorized_products[0].origin = Some("https://otherline.cc".to_string());

        let credentials =
            credentials_from_connections(vec![burn.clone(), legacy], Some(&burn), None);
        let settings = default_settings();
        let profile = selected_profile_for_settings(&settings);

        let connections = connections_for_profile(&credentials, &profile);
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].device_id, "dev_burn");
        assert_eq!(
            active_connection_products(&connections[0])[0].id,
            "panda-burn"
        );

        let products = credentials_products_for_profile(&credentials, &profile);
        assert_eq!(products.len(), 1);
        assert_eq!(products[0].id, "panda-burn");
    }

    #[test]
    fn pending_preview_public_value_hides_local_scope_state() {
        let public = pending_claim_public_value(&test_pending_intent_claim());
        assert_eq!(public["local_root_state"], Value::Null);
        assert_eq!(public["scope_widening"], Value::Null);
        assert_eq!(public["scope_diff"], Value::Null);
        assert_eq!(public["confirmation_mode"], "confirm");
    }

    #[test]
    fn heartbeat_interval_defaults_to_thirty_seconds_and_allows_env_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var("PANDA_BRIDGE_HEARTBEAT_INTERVAL_MS");
        assert_eq!(heartbeat_interval_ms(), 30_000);
        env::set_var("PANDA_BRIDGE_HEARTBEAT_INTERVAL_MS", "1234");
        assert_eq!(heartbeat_interval_ms(), 1234);
        env::remove_var("PANDA_BRIDGE_HEARTBEAT_INTERVAL_MS");
    }

    #[test]
    fn local_policy_preview_defaults_to_relay_only() {
        let preview = local_policy_preview();
        assert_eq!(preview["version"], "BRIDGE-RELAY-AUTH-v1");
        assert_eq!(preview["request_source"], "desktop_default_relay");
        assert_eq!(
            preview["capabilities"],
            json!(["relay.envelope", "relay.ack"])
        );
        assert_eq!(preview["workspace_roots"], Value::Null);
        assert_eq!(preview["sandbox_floor"], Value::Null);
        assert_eq!(preview["approval_policy_floor"], Value::Null);
        assert_eq!(preview["allow_developer_instructions"], Value::Null);
        assert_eq!(capabilities()["runtime"], Value::Null);
        assert_eq!(
            capabilities()["relay"],
            json!(["relay.envelope", "relay.ack"])
        );
        assert_eq!(local_state()["commands"], Value::Null);
        assert_eq!(local_state()["workspaces"], Value::Null);
    }

    #[test]
    fn managed_adapter_manifest_starts_node_runtime_and_returns_endpoint() {
        let _guard = ENV_LOCK.lock().unwrap();
        if Command::new(node_runtime_command())
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        env::remove_var("PANDA_BRIDGE_ADAPTER_PANDA_BURN_URL");
        env::remove_var("PANDA_BRIDGE_ADAPTER_URL");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let tmp = env::temp_dir().join(format!("panda-bridge-managed-adapter-{suffix}"));
        let adapter_dir = tmp.join("adapters").join("panda-burn");
        fs::create_dir_all(&adapter_dir).unwrap();
        fs::write(adapter_dir.join("adapter.mjs"), r#"
import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(JSON.stringify({ ok: true, product_id: "panda-burn", url: `http://127.0.0.1:${address.port}/v1/relay-envelope` }));
});
setInterval(() => {}, 1000);
"#).unwrap();
        fs::write(
            adapter_dir.join("adapter.manifest.json"),
            r#"{
  "schema": "panda.bridge.managed-adapter.v1",
  "product_id": "panda-burn",
  "product_name": "Burn",
  "runtime": { "type": "node", "entry": "adapter.mjs", "args": [], "cwd": "." }
}
"#,
        )
        .unwrap();
        env::set_var("PANDA_BRIDGE_MANAGED_ADAPTERS_DIR", tmp.join("adapters"));
        let endpoint = adapter_endpoint_for_product("panda-burn").unwrap();
        assert!(endpoint.contains("/v1/relay-envelope"));
        let info = managed_adapter_info("panda-burn").unwrap();
        assert_eq!(info["running"], true);
        assert_eq!(info["endpoint_source"], Value::Null);
        if let Ok(mut processes) = managed_adapters().lock() {
            if let Some(mut process) = processes.remove("panda-burn") {
                let _ = process.child.kill();
            }
        }
        env::remove_var("PANDA_BRIDGE_MANAGED_ADAPTERS_DIR");
        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn intent_authorization_policy_defaults_to_relay_only() {
        let intent = ConnectIntent {
            product_id: "bridge-demo".to_string(),
            product: None,
            policy: json!({}),
            source_origin: Some("http://local.test".to_string()),
            device_name: Some("Device".to_string()),
            expires_at: "2099-01-01T00:00:00Z".to_string(),
            user: None,
        };
        let product_capabilities = vec!["relay.envelope".to_string(), "relay.ack".to_string()];
        let policy = intent_authorization_policy(
            &intent,
            "bridge-demo",
            "http://local.test",
            &product_capabilities,
        );
        assert_eq!(policy["version"], "BRIDGE-RELAY-AUTH-v1");
        assert_eq!(policy["request_source"], "desktop_default_relay");
        assert_eq!(
            policy["capabilities"],
            json!(["relay.envelope", "relay.ack"])
        );
        assert_eq!(policy["workspace_roots"], Value::Null);
        assert_eq!(policy["sandbox_floor"], Value::Null);
        assert_eq!(policy["approval_policy_floor"], Value::Null);
        assert_eq!(policy["allow_developer_instructions"], Value::Null);
    }

    #[test]
    fn merge_authorized_products_preserves_pending_until_confirm() {
        let products = merge_authorized_products(
            None,
            Some("bridge-demo".to_string()),
            Some("Bridge Demo".to_string()),
            Some("http://local.test".to_string()),
            vec!["relay.envelope".to_string()],
            json!({ "capabilities": ["relay.envelope"] }),
            1,
            AuthorizationState::Pending,
        );
        assert_eq!(products.len(), 1);
        assert_eq!(products[0].authorization, AuthorizationState::Pending);
        assert!(!products[0].authorization.is_active());
    }

    #[test]
    fn product_display_origin_prefers_authorization_policy_source() {
        let product = json!({
            "origin": "https://bridge.test.example",
            "policy": { "source_origin": "https://app.test.example" }
        });
        assert_eq!(product_display_origin(&product), "https://app.test.example");

        let fallback = json!({ "origin": "https://bridge.test.example" });
        assert_eq!(
            product_display_origin(&fallback),
            "https://bridge.test.example"
        );
    }

    #[test]
    fn builtin_screenshot_renderer_writes_png_file() {
        let path = env::temp_dir().join(format!(
            "panda-bridge-builtin-screenshot-{}.png",
            next_event_seq()
        ));
        let snapshot = json!({
            "ok": true,
            "status": {
                "device_id": "dev_1",
                "device_name": "Verifier Desktop",
                "worker_running": false,
                "realtime_connected": false,
                "relay_available": true,
                "authorized_products": [{
                    "id": "bridge-demo",
                    "name": "Bridge Demo",
                    "origin": "http://chat.local.test",
                    "capabilities": ["relay.envelope", "relay.ack"],
                    "accounts": [{ "id": "user_1", "device_id": "dev_1", "authorized_at": "unix:1" }]
                }]
            },
            "events": []
        });
        write_builtin_screenshot(&path, &snapshot).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(bytes.len() > 1024);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn desktop_ui_html_embeds_split_assets() {
        let html = desktop_ui_html();
        assert!(!html.contains("__PANDA_BRIDGE_DESKTOP_CSS__"));
        assert!(!html.contains("__PANDA_BRIDGE_DESKTOP_JS__"));
        assert!(html.contains(".win{"));
        assert!(html.contains("window.PandaBridge"));
        assert!(html.contains("const BASE_PRODUCTS="));
    }
}
