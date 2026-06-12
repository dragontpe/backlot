import { useEffect, useRef, useState, useCallback } from "react";
import { Viewer, PointLightDef, CameraBookmark, objectLabel } from "./viewer/Viewer";
import { formatHour } from "./viewer/daylight";

const IS_TAURI = "__TAURI_INTERNALS__" in window;

const LIGHT_PRESETS: { name: string; color: string; intensity: number; kind: "point" | "window" }[] = [
  { name: "Lamp", color: "#ffb46b", intensity: 40, kind: "point" },
  { name: "Fluorescent", color: "#e4fff4", intensity: 60, kind: "point" },
  { name: "Bulb", color: "#fff1d6", intensity: 35, kind: "point" },
  { name: "Neon pink", color: "#ff5fa2", intensity: 30, kind: "point" },
  { name: "TV glow", color: "#7fb4ff", intensity: 25, kind: "point" },
  { name: "Window", color: "#cfe2ff", intensity: 60, kind: "window" },
];

interface SavedView {
  name: string;
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
  kind: "scene" | "area";
}

interface RawArea {
  name: string;
  depth: number;
  verts: number;
  min: [number, number, number];
  max: [number, number, number];
}

/** Turn exported group bboxes into walk-in viewpoints: filter out wall
 *  slivers/furniture, dedupe nested wrappers, stand at eye height inside. */
function areasToViews(raw: RawArea[]): SavedView[] {
  const rooms = raw.filter((a) => {
    const dx = a.max[0] - a.min[0];
    const dy = a.max[1] - a.min[1];
    const dz = a.max[2] - a.min[2];
    return dx * dy * dz >= 5 && dy >= 1.8 && Math.min(dx, dz) >= 1.5 && a.verts >= 500;
  });
  const deduped: RawArea[] = [];
  for (const a of rooms) {
    const dup = deduped.some(
      (b) =>
        a.min.every((v, i) => Math.abs(v - b.min[i]) < 0.25) &&
        a.max.every((v, i) => Math.abs(v - b.max[i]) < 0.25)
    );
    if (!dup) deduped.push(a);
  }
  const floors = [...new Set(deduped.map((a) => Math.round(a.min[1] / 3)))].sort((x, y) => x - y);
  return deduped.slice(0, 40).map((a, i) => {
    const dx = a.max[0] - a.min[0];
    const dz = a.max[2] - a.min[2];
    const cx = (a.min[0] + a.max[0]) / 2;
    const cz = (a.min[2] + a.max[2]) / 2;
    const eyeY = Math.min(a.min[1] + 1.5, a.max[1] - 0.3);
    const along: [number, number, number] = dx >= dz ? [1, 0, 0] : [0, 0, 1];
    const floor = floors.indexOf(Math.round(a.min[1] / 3));
    const floorTag = floors.length > 1 ? ` · ${floor + 1}F` : "";
    const label = a.name.trim() || `Area ${i + 1} (${dx.toFixed(1)}×${dz.toFixed(1)}m${floorTag})`;
    return {
      name: label,
      fov: 60,
      position: [cx, eyeY, cz],
      target: [cx + along[0] * 3, eyeY, cz + along[2] * 3],
      kind: "area" as const,
    };
  });
}

interface SceneState {
  time: number;
  exposure: number;
  fov: number;
  skyPath: string | null;
  lights: PointLightDef[];
  bookmarks: CameraBookmark[];
  /** OBJ object names ("objN label") hidden from view & capture. */
  hidden: string[];
}

const DEFAULT_STATE: SceneState = {
  time: 12,
  exposure: 1,
  fov: 50,
  skyPath: null,
  lights: [],
  bookmarks: [],
  hidden: [],
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);

  const [scenePath, setScenePath] = useState<string | null>(null);
  const [sceneDir, setSceneDir] = useState<string | null>(null);
  const [status, setStatus] = useState("Open a .skp scene to begin");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<SceneState>(DEFAULT_STATE);
  const [placing, setPlacing] = useState<(typeof LIGHT_PRESETS)[number] | null>(null);
  const [captureRes, setCaptureRes] = useState(2);
  const [bookmarkName, setBookmarkName] = useState("");
  const [views, setViews] = useState<SavedView[]>([]);
  const [markersVisible, setMarkersVisible] = useState(true);
  const [hiding, setHiding] = useState(false);

  // Undo: snapshots of SceneState. Slider drags coalesce by key.
  const undoStack = useRef<SceneState[]>([]);
  const lastUndoKey = useRef<{ key: string; at: number }>({ key: "", at: 0 });

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

  /** Snapshot current state for Cmd+Z. Same key within 1.2s coalesces
   *  (one undo step per slider drag, not per tick). */
  const pushUndo = useCallback((key: string) => {
    const now = Date.now();
    if (lastUndoKey.current.key === key && now - lastUndoKey.current.at < 1200) {
      lastUndoKey.current.at = now;
      return;
    }
    lastUndoKey.current = { key, at: now };
    setState((prev) => {
      undoStack.current.push(JSON.parse(JSON.stringify(prev)));
      if (undoStack.current.length > 50) undoStack.current.shift();
      return prev;
    });
  }, []);

  const update = useCallback(
    (patch: Partial<SceneState>, undoKey?: string) => {
      if (undoKey) pushUndo(undoKey);
      setState((prev) => {
        const next = { ...prev, ...patch };
        persist(next);
        return next;
      });
    },
    [persist, pushUndo]
  );

  const undo = useCallback(() => {
    const snapshot = undoStack.current.pop();
    if (!snapshot) return;
    lastUndoKey.current = { key: "", at: 0 };
    const v = viewerRef.current!;
    v.syncLights(snapshot.lights);
    v.setTimeOfDay(snapshot.time);
    v.setExposure(snapshot.exposure);
    v.setFov(snapshot.fov);
    v.setHidden(snapshot.hidden ?? []);
    setState((prev) => {
      if (snapshot.skyPath !== prev.skyPath) {
        (async () => {
          try {
            await v.setSkyImage(
              snapshot.skyPath ? (IS_TAURI ? await assetUrl(snapshot.skyPath) : snapshot.skyPath) : null
            );
          } catch { /* sky file gone */ }
        })();
      }
      persist(snapshot);
      return snapshot;
    });
    setStatus("Undone");
  }, [persist]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

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
      // Views dropdown: author-saved SketchUp scenes + detected room areas
      try {
        const list: SavedView[] = [];
        const rs = await fetch(resolve("scenes.json"));
        if (rs.ok) {
          for (const s of await rs.json()) list.push({ ...s, kind: "scene" });
        }
        const ra = await fetch(resolve("areas.json"));
        if (ra.ok) list.push(...areasToViews(await ra.json()));
        setViews(list);
      } catch {
        setViews([]);
      }
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
      v.setHidden(restored.hidden);
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
      undoStack.current = [];
      lastUndoKey.current = { key: "", at: 0 };
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
    update({ skyPath: picked }, "sky");
  }

  async function clearSky() {
    await viewerRef.current!.setSkyImage(null);
    update({ skyPath: null }, "sky");
  }

  // ---- lights ----
  function startPlacing(preset: (typeof LIGHT_PRESETS)[number]) {
    stopHiding();
    const v = viewerRef.current!;
    // placing a light you can't see is guesswork — force markers on
    setMarkersVisible(true);
    v.setMarkersVisible(true);
    setPlacing(preset);
    v.placing = true;
    v.onPlace = (p) => {
      pushUndo(`light-add-${Date.now()}`);
      const def = v.addLight({
        name: preset.name,
        color: preset.color,
        intensity: preset.intensity,
        position: [p.x, p.y, p.z],
        kind: preset.kind,
        target:
          preset.kind === "window"
            ? (v.camera.position.toArray() as [number, number, number])
            : undefined,
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

  // ---- hide objects ----
  function startHiding() {
    cancelPlacing();
    const v = viewerRef.current!;
    setHiding(true);
    v.hiding = true;
    // Stays in hide mode — each click hides one object (own undo step).
    v.onHideClick = (name) => {
      pushUndo(`hide-${Date.now()}`);
      setState((prev) => {
        const next = { ...prev, hidden: [...prev.hidden, name] };
        persist(next);
        return next;
      });
    };
  }

  function stopHiding() {
    const v = viewerRef.current!;
    v.hiding = false;
    v.onHideClick = null;
    setHiding(false);
  }

  function unhideObject(name: string) {
    pushUndo(`unhide-${Date.now()}`);
    setState((prev) => {
      const next = { ...prev, hidden: prev.hidden.filter((n) => n !== name) };
      viewerRef.current!.setHidden(next.hidden);
      persist(next);
      return next;
    });
  }

  function unhideAll() {
    pushUndo(`unhide-all-${Date.now()}`);
    setState((prev) => {
      const next = { ...prev, hidden: [] };
      viewerRef.current!.setHidden([]);
      persist(next);
      return next;
    });
  }

  function changeLight(id: number, patch: Partial<PointLightDef>) {
    pushUndo(`light-edit-${id}`);
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
    pushUndo(`light-del-${Date.now()}`);
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
    update({ bookmarks: [...state.bookmarks, b] }, `bm-add-${Date.now()}`);
    setBookmarkName("");
  }

  function applyBookmark(b: CameraBookmark) {
    viewerRef.current!.applyCameraState(b);
    update({ fov: b.fov });
  }

  function removeBookmark(i: number) {
    update({ bookmarks: state.bookmarks.filter((_, j) => j !== i) }, `bm-del-${Date.now()}`);
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
          {hiding && (
            <div className="placing-hint">
              Click objects to hide them — <button onClick={stopHiding}>done</button>
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
                onChange={(e) => update({ time: Number(e.target.value) }, "time")}
              />
            </label>
            <label className="row">
              <span>Exposure {state.exposure.toFixed(2)}</span>
              <input
                type="range" min={0.3} max={2.5} step={0.05}
                value={state.exposure}
                onChange={(e) => update({ exposure: Number(e.target.value) }, "exposure")}
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
                <span className="light-name">{l.kind === "window" ? "▢" : "●"}</span>
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
            {state.lights.length === 0 && (
              <div className="hint">For interiors: place lamps & tubes — or click a window with the Window preset. Cmd+Z undoes.</div>
            )}
            {state.lights.length > 0 && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={markersVisible}
                  onChange={(e) => {
                    setMarkersVisible(e.target.checked);
                    viewerRef.current!.setMarkersVisible(e.target.checked);
                  }}
                />
                Show light markers
              </label>
            )}
          </section>

          <section>
            <h3>Objects</h3>
            <div className="row buttons">
              <button className="btn" onClick={hiding ? stopHiding : startHiding} disabled={busy}>
                {hiding ? "Done hiding" : "Hide objects…"}
              </button>
              {state.hidden.length > 1 && (
                <button className="btn" onClick={unhideAll}>
                  Show all
                </button>
              )}
            </div>
            {state.hidden.map((name) => (
              <div className="bookmark-row" key={name}>
                <span className="objname" title={name}>
                  {objectLabel(name)}
                </span>
                <button className="btn tiny" onClick={() => unhideObject(name)} title="Show again">
                  👁
                </button>
              </div>
            ))}
            {state.hidden.length === 0 && !hiding && (
              <div className="hint">Hide roofs, ceilings or walls to shoot into rooms. Cmd+Z undoes.</div>
            )}
          </section>

          <section>
            <h3>Camera</h3>
            {views.length > 0 && (
              <label className="row">
                <span>Jump to area</span>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const view = views[Number(e.target.value)];
                    if (!view) return;
                    viewerRef.current!.applyCameraState(view);
                    update({ fov: Math.round(view.fov) });
                    e.target.value = "";
                  }}
                >
                  <option value="" disabled>
                    {views.length} places…
                  </option>
                  {views.some((v) => v.kind === "scene") && (
                    <optgroup label="Saved views">
                      {views.map((view, i) =>
                        view.kind === "scene" ? (
                          <option key={i} value={i}>
                            {view.name}
                          </option>
                        ) : null
                      )}
                    </optgroup>
                  )}
                  {views.some((v) => v.kind === "area") && (
                    <optgroup label="Detected areas">
                      {views.map((view, i) =>
                        view.kind === "area" ? (
                          <option key={i} value={i}>
                            {view.name}
                          </option>
                        ) : null
                      )}
                    </optgroup>
                  )}
                </select>
              </label>
            )}
            <label className="row">
              <span>FOV {state.fov}°</span>
              <input
                type="range" min={15} max={100} step={1}
                value={state.fov}
                onChange={(e) => update({ fov: Number(e.target.value) }, "fov")}
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
