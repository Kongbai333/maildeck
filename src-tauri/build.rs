fn main() {
    // MinGW ld 读不了 tauri-winres 产出的 MSVC COFF resource.lib；GNU 目标跳过
    // Windows 资源嵌入（只影响 exe 图标/版本信息），MSVC 目标仍走完整构建。
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") {
        println!("cargo:rerun-if-changed=tauri.conf.json");
        println!("cargo:rerun-if-changed=capabilities");
        return;
    }
    tauri_build::build()
}
