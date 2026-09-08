#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Windows has been seen to re-add WS_CAPTION after create; pin decorations off
      // here so the custom #tbar is the only chrome, matching tauri.conf.json.
      if let Some(win) = tauri::Manager::get_webview_window(app, "main") {
        let _ = win.set_decorations(false);
      }
      Ok(())
    })
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
