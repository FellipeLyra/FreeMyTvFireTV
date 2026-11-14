// Free My TV Studio desktop shell. The editor is the web app in ../src; this
// shell only hosts it in a native window (WebView2 on Windows). Projects are
// opened and saved with the WebView's file dialogs, so no extra native
// permissions are granted here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Free My TV Studio");
}
