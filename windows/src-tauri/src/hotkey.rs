// Global shortcut that opens and closes the island: Win+Alt+C.
//
// RegisterHotKey needs a message loop on the thread that registered it, so the
// shortcut lives on its own thread and only emits an event to the island, which
// decides what "toggle" means. No extra dependency: this is plain Win32.

use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_ALT, MOD_NOREPEAT, MOD_WIN};
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

use crate::island::WINDOW_LABEL;
use crate::log;

const HOTKEY_ID: i32 = 0xC0C0;
/// Virtual-key code of the letter C.
const VK_C: u32 = 0x43;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || unsafe {
        if let Err(err) = RegisterHotKey(None, HOTKEY_ID, MOD_WIN | MOD_ALT | MOD_NOREPEAT, VK_C) {
            // Another program owns the combination: the island still works with the mouse.
            log::line(format!("global shortcut Win+Alt+C unavailable: {err}"));
            return;
        }
        log::line("global shortcut Win+Alt+C registered");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_HOTKEY {
                let _ = app.emit_to(WINDOW_LABEL, "hotkey", ());
            }
        }
    });
}
