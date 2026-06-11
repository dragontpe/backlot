#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize)]
struct ConvertResult {
    dir: String,
    stats: String,
    cached: bool,
}

fn converter_path() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            candidates.push(d.join("skp2obj"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("skp-studio/converter/skp2obj"));
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "skp2obj converter binary not found".to_string())
}

fn cache_dir_for(skp: &Path) -> Result<PathBuf, String> {
    let meta = fs::metadata(skp).map_err(|e| format!("cannot stat {}: {e}", skp.display()))?;
    let mut h = DefaultHasher::new();
    skp.to_string_lossy().hash(&mut h);
    meta.len().hash(&mut h);
    if let Ok(m) = meta.modified() {
        if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
            d.as_secs().hash(&mut h);
        }
    }
    let base = dirs::cache_dir().ok_or("no cache dir")?.join("backlot");
    Ok(base.join(format!("{:016x}", h.finish())))
}

/// Browsers can't decode TIFF. Some ACON textures are TIFF bytes regardless of
/// their extension, so sniff magic bytes and convert via macOS `sips`.
fn normalize_tiff_textures(dir: &Path) -> Result<(), String> {
    let tex_dir = dir.join("textures");
    let entries = match fs::read_dir(&tex_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    let mut renames: Vec<(String, String)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(head) = fs::read(&path).map(|b| b[..b.len().min(4)].to_vec()) else {
            continue;
        };
        let is_tiff = head.starts_with(b"II*\0") || head.starts_with(b"MM\0*");
        if !is_tiff {
            continue;
        }
        let png = path.with_extension("png.converted");
        let status = Command::new("sips")
            .args(["-s", "format", "png"])
            .arg(&path)
            .arg("--out")
            .arg(&png)
            .output()
            .map_err(|e| format!("sips failed: {e}"))?;
        if !status.status.success() {
            continue; // leave as-is; material falls back to its solid color
        }
        let old_name = path.file_name().unwrap().to_string_lossy().to_string();
        let new_name = format!(
            "{}.png",
            path.file_stem().unwrap_or_default().to_string_lossy()
        );
        fs::remove_file(&path).ok();
        fs::rename(&png, tex_dir.join(&new_name)).map_err(|e| e.to_string())?;
        if old_name != new_name {
            renames.push((old_name, new_name));
        }
    }
    if !renames.is_empty() {
        let mtl_path = dir.join("model.mtl");
        if let Ok(mut mtl) = fs::read_to_string(&mtl_path) {
            for (old, new) in &renames {
                mtl = mtl.replace(&format!("textures/{old}"), &format!("textures/{new}"));
            }
            fs::write(&mtl_path, mtl).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn convert_skp(path: String) -> Result<ConvertResult, String> {
    let skp = PathBuf::from(&path);
    if !skp.exists() {
        return Err(format!("file not found: {path}"));
    }
    let out_dir = cache_dir_for(&skp)?;
    let obj = out_dir.join("model.obj");

    if obj.exists() && fs::metadata(&obj).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(ConvertResult {
            dir: out_dir.to_string_lossy().into(),
            stats: "cached".into(),
            cached: true,
        });
    }

    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let conv = converter_path()?;
    let output = Command::new(&conv)
        .arg(&skp)
        .arg(&out_dir)
        .output()
        .map_err(|e| format!("failed to run converter: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() || !obj.exists() {
        fs::remove_dir_all(&out_dir).ok();
        return Err(format!("conversion failed: {stderr}"));
    }
    normalize_tiff_textures(&out_dir)?;

    Ok(ConvertResult {
        dir: out_dir.to_string_lossy().into(),
        stats: stderr.lines().last().unwrap_or("").to_string()
            + " | "
            + stderr.lines().nth(1).unwrap_or(""),
        cached: false,
    })
}

#[tauri::command]
async fn save_png(path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("bad base64: {e}"))?;
    fs::write(&path, bytes).map_err(|e| format!("write failed: {e}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![convert_skp, save_png])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
