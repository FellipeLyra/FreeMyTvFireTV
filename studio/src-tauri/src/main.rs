// Free My TV Studio desktop shell. The editor is the web app in ../src; this
// shell hosts it in a native window (WebView2 on Windows). Projects are opened
// and saved with the WebView's file dialogs, so no extra native permissions are
// granted here.
//
// Phase 9: the installed Studio carries its own bridge to the Fire TV
// (bin/fmtv.exe, the fmtv CLI as a single executable, with bin/adb/adb.exe).
// It is started here as `fmtv serve --port 5611 --exit-with-stdin`, listening on
// 127.0.0.1 only; the editor finds it the same way it finds `node tools/fmtv.mjs
// serve`. The bridge stops when the Studio closes (its stdin closes, even if the
// Studio crashes). In `npm run desktop` the dev server already has the bridge,
// so nothing is started when bin/ is missing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

struct Bridge(Mutex<Option<Child>>);

fn start_bridge(dir: PathBuf) -> Option<Child> {
    let exe = dir.join(if cfg!(windows) { "fmtv.exe" } else { "fmtv" });
    if !exe.exists() {
        return None;
    }
    let adb = dir.join("adb").join(if cfg!(windows) { "adb.exe" } else { "adb" });
    let mut cmd = Command::new(&exe);
    cmd.args(["serve", "--port", "5611", "--exit-with-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if adb.exists() {
        cmd.env("ADB", &adb);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window behind the Studio
    cmd.spawn().ok()
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let child = app
                .path()
                .resource_dir()
                .ok()
                .and_then(|r| start_bridge(r.join("bin")));
            app.manage(Bridge(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Free My TV Studio");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Bridge>() {
                if let Some(mut child) = state.0.lock().ok().and_then(|mut c| c.take()) {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
