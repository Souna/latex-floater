// Hide the console window on Windows release builds; otherwise a terminal
// would pop up behind the floater every launch.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    latex_floater_lib::run()
}
