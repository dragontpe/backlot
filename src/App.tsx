import { useEffect, useRef, useState, useCallback } from "react";
import { Viewer, PointLightDef, CameraBookmark } from "./viewer/Viewer";
import { formatHour } from "./viewer/daylight";

const IS_TAURI = "__TAURI_INTERNALS__" in window;

const LIGHT_PRESETS = [
  { name: "Lamp", color: "#ffb46b", intensity: 40 },
  { name: "Fluorescent", color: "#e4fff4", intensity: 60 },
  { name: "Bulb", color: "#fff1d6", intensity: 35 },
  { name: "Neon pink", color: "#ff5fa2", intensity: 30 },
  { name: "TV glow", color: "#7fb4ff", intensity: 25 },
];

interface SceneState {
  time: number;
  exposure: number;
  fov: number;
  skyPath: string | null;
  lights: PointLightDef[];
  bookmarks: CameraBookmark[];
}

const DEFAULT_STATE: SceneState = {
  time: 12,
  exposure: 1,
  fov: 50,
  skyPath: null,
  lights: [],
  bookmarks: [],
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);

  const [scenePath, setScenePath] = useState<string | null>(null);
  const [sceneDir, setSceneDir] = useState<string | null>(null);
  const [status, setStatus] = useState("Open a .skp scene to begin");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<SceneState>(DEFAULT_STATE);
  const [placing, setPlacing] = useState<{ color: string; intensity: number; name: string } | null>(null);
  const [captureRes, setCaptureRes] = useState(2);
  const [bookmarkName, setBookmarkName] = useState("");

  // ---- viewer lifecycle ----
  useEffect(() => {
    if (!canvasRef.current) return;
    const v = new Viewer(canvasRef.current);
    viewerRef.current = v;
    (window as unknown as { __viewer: Viewer }).__viewer = v;
    v.setTimeOfDay(12);
    const onResize = () => v.resize();
    window.addEventListener("resize", onResize);

    // Browser dev mode: ?src=http://localhost:8077 loads a converted dir over HTTP
    const src = new URLSearchParams(location.search).get("src");
    if (src && !IS_TAURI) {
      loadFrom((rel) => `${src}/${rel}`, src);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      v.renderer.setAnimationLoop(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistKey = scenePath ? `backlot:${scenePath}` : null;

  const persist = useCallback(
    (s: SceneState) => {
      if (persistKey) localStorage.setItem(persistKey, JSON.stringify(s));
    },
    [persistKey]
  );

  const update = useCallback(
    (patch: Partial<SceneState>) => {
      setState((prev) => {
        const next = { ...prev, ...patch };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  // ---- apply state to viewer ----
  useEffect(() => {
    viewerRef.current?.setTimeOfDay(state.time);
  }, [state.time]);
  useEffect(() => {
    viewerRef.current?.setExposure(state.exposure);
  }, [state.exposure]);
  useEffect(() => {
    viewerRef.current?.setFov(state.fov);
  }, [state.fov]);

  async function assetUrl(path: string): Promise<string> {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(path);
  }

  async function loadFrom(resolve: (rel: string) => string, pathKey: string) {
    const v = viewerRef.current!;
    setBusy(true);
    setStatus("Loading geometry…");
    try {
      const { triangles } = await v.load(resolve);
      setStatus(`${(triangles / 1000).toFixed(0)}k triangles`);
      // restore saved state or defaults
      const savedRaw = localStorage.getItem(`backlot:${pathKey}`);
      const saved: SceneState = savedRaw ? JSON.parse(savedRaw) : DEFAULT_STATE;
      v.clearLights();
      const lights: PointLightDef[] = [];
      for (const l of saved.lights ?? []) {
        lights.push(v.addLight(l));
      }
      const restored = { ...DEFAULT_STATE, ...saved, lights };
      setState(restored);
      v.setTimeOfDay(restored.time);
      v.setExposure(restored.exposure);
      v.setFov(restored.fov);
      if (restored.skyPath) {
        try {
          await v.setSkyImage(IS_TAURI ? await assetUrl(restored.skyPath) : restored.skyPath);
        } catch {
          /* sky file moved; ignore */
        }
      } else {
        await v.setSkyImage(null);
      }
      if (restored.bookmarks.length) {
        v.applyCameraState(restored.bookmarks[0]);
      } else {
        v.frameModel();
      }
    } catch (e) {
      setStatus(`Load failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function openScene() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      filters: [{ name: "SketchUp", extensions: ["skp"] }],
      multiple: false,
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    setStatus("Converting .skp…");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<{ dir: string; stats: string; cached: boolean }>("convert_skp", {
        path: picked,
      });
      setScenePath(picked);
      setSceneDir(res.dir);
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      await loadFrom((rel) => convertFileSrc(`${res.dir}/${rel}`), picked);
    } catch (e) {
      setStatus(`${e}`);
      setBusy(false);
    }
  }

  async function pickSky() {
    if (!IS_TAURI) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
      multiple: false,
    });
    if (typeof picked !== "string") return;
    await viewerRef.current!.setSkyImage(await assetUrl(picked));
    update({ skyPath: picked });
  }

  async function clearSky() {
    await viewerRef.current!.setSkyImage(null);
    update({ skyPath: null });
  }

  // ---- lights ----
  function startPlacing(preset: (typeof LIGHT_PRESETS)[number]) {
    const v = viewerRef.current!;
    setPlacing(preset);
    v.placing = true;
    v.onPlace = (p) => {
      const def = v.addLight({
        name: preset.name,
        color: preset.color,
        intensity: preset.intensity,
        position: [p.x, p.y, p.z],
      });
      setState((prev) => {
        const next = { ...prev, lights: [...prev.lights, def] };
        persist(next);
        return next;
      });
      v.placing = false;
      v.onPlace = null;
      setPlacing(null);
    };
  }

  function cancelPlacing() {
    const v = viewerRef.current!;
    v.placing = false;
    v.onPlace = null;
    setPlacing(null);
  }

  function changeLight(id: number, patch: Partial<PointLightDef>) {
    setState((prev) => {
      const lights = prev.lights.map((l) => (l.id === id ? { ...l, ...patch } : l));
      const updated = lights.find((l) => l.id === id)!;
      viewerRef.current!.updateLight(updated);
      const next = { ...prev, lights };
      persist(next);
      return next;
    });
  }

  function removeLight(id: number) {
    viewerRef.current!.removeLight(id);
    setState((prev) => {
      const next = { ...prev, lights: prev.lights.filter((l) => l.id !== id) };
      persist(next);
      return next;
    });
  }

  // ---- bookmarks ----
  function saveBookmark() {
    const v = viewerRef.current!;
    const name = bookmarkName.trim() || `Angle ${state.bookmarks.length + 1}`;
    const b: CameraBookmark = { name, ...v.getCameraState() };
    update({ bookmarks: [...state.bookmarks, b] });
    setBookmarkName("");
  }

  function applyBookmark(b: CameraBookmark) {
    viewerRef.current!.applyCameraState(b);
    update({ fov: b.fov });
  }

  function removeBookmark(i: number) {
    update({ bookmarks: state.bookmarks.filter((_, j) => j !== i) });
  }

  // ---- capture ----
  async function capture() {
    const v = viewerRef.current!;
    setBusy(true);
    setStatus("Rendering capture…");
    try {
      const data = v.capture(captureRes);
      if (IS_TAURI) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const base = scenePath?.split("/").pop()?.replace(/\.skp$/i, "") ?? "scene";
        const path = await save({
          defaultPath: `${base}-${formatHour(state.time).replace(":", "")}.png`,
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (path) {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("save_png", { path, data });
          setStatus(`Saved ${path.split("/").pop()}`);
        } else {
          setStatus("Capture cancelled");
        }
      } else {
        const a = document.createElement("a");
        a.href = `data:image/png;base64,${data}`;
        a.download = "capture.png";
        a.click();
        setStatus("Capture downloaded");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          BACK<span>LOT</span>
        </div>
        <button className="btn primary" onClick={openScene} disabled={busy || !IS_TAURI}>
          Open .skp
        </button>
        <div className="status">{status}</div>
        <div className="spacer" />
        <select
          value={captureRes}
          onChange={(e) => setCaptureRes(Number(e.target.value))}
          title="Capture resolution"
        >
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={3}>3x</option>
          <option value={4}>4x</option>
        </select>
        <button className="btn capture" onClick={capture} disabled={busy || (!sceneDir && IS_TAURI)}>
          ◉ Capture
        </button>
      </header>

      <div className="main">
        <div className="canvas-wrap">
          <canvas ref={canvasRef} />
          {placing && (
            <div className="placing-hint">
              Click a surface to place “{placing.name}” — <button onClick={cancelPlacing}>cancel</button>
            </div>
          )}
          <div className="nav-help">drag orbit · scroll zoom · WASD fly · QE up/down · arrows pan · shift fast</div>
        </div>

        <aside className="panel">
          <section>
            <h3>Daylight</h3>
            <label className="row">
              <span>Time {formatHour(state.time)}</span>
              <input
                type="range" min={0} max={24} step={0.25}
                value={state.time}
                onChange={(e) => update({ time: Number(e.target.value) })}
              />
            </label>
            <label className="row">
              <span>Exposure {state.exposure.toFixed(2)}</span>
              <input
                type="range" min={0.3} max={2.5} step={0.05}
                value={state.exposure}
                onChange={(e) => update({ exposure: Number(e.target.value) })}
              />
            </label>
            <div className="row buttons">
              <button className="btn" onClick={pickSky} disabled={!IS_TAURI}>
                Sky image…
              </button>
              {state.skyPath && (
                <button className="btn" onClick={clearSky}>
                  Clear sky
                </button>
              )}
            </div>
            {state.skyPath && <div className="skyname">{state.skyPath.split("/").pop()}</div>}
          </section>

          <section>
            <h3>Point lights</h3>
            <div className="presets">
              {LIGHT_PRESETS.map((p) => (
                <button
                  key={p.name}
                  className="btn preset"
                  style={{ borderColor: p.color }}
                  onClick={() => startPlacing(p)}
                  disabled={!!placing}
                >
                  + {p.name}
                </button>
              ))}
            </div>
            {state.lights.map((l) => (
              <div className="light-row" key={l.id}>
                <input
                  type="color"
                  value={l.color}
                  onChange={(e) => changeLight(l.id, { color: e.target.value })}
                />
                <input
                  type="range" min={1} max={200} step={1}
                  value={l.intensity}
                  onChange={(e) => changeLight(l.id, { intensity: Number(e.target.value) })}
                />
                <button className="btn tiny" onClick={() => removeLight(l.id)}>
                  ✕
                </button>
              </div>
            ))}
            {state.lights.length === 0 && <div className="hint">For interiors: place lamps & tubes.</div>}
          </section>

          <section>
            <h3>Camera</h3>
            <label className="row">
              <span>FOV {state.fov}°</span>
              <input
                type="range" min={15} max={100} step={1}
                value={state.fov}
                onChange={(e) => update({ fov: Number(e.target.value) })}
              />
            </label>
            <div className="row buttons">
              <input
                className="bookmark-name"
                placeholder="angle name"
                value={bookmarkName}
                onChange={(e) => setBookmarkName(e.target.value)}
              />
              <button className="btn" onClick={saveBookmark}>
                Save angle
              </button>
            </div>
            {state.bookmarks.map((b, i) => (
              <div className="bookmark-row" key={i}>
                <button className="btn wide" onClick={() => applyBookmark(b)}>
                  {b.name}
                </button>
                <button className="btn tiny" onClick={() => removeBookmark(i)}>
                  ✕
                </button>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
