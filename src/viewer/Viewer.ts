import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { daylightAt } from "./daylight";

export interface PointLightDef {
  id: number;
  name: string;
  color: string;
  intensity: number;
  position: [number, number, number];
  /** "window" = soft rect area light shining into the room. */
  kind?: "point" | "window";
  /** For window lights: point the light faces (placement-time camera). */
  target?: [number, number, number];
}

export interface CameraBookmark {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export class Viewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;

  private sun = new THREE.DirectionalLight(0xffffff, 1.5);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
  private model: THREE.Group | null = null;
  private modelBox = new THREE.Box3();
  private skyTexture: THREE.Texture | null = null;
  private bgColor = new THREE.Color(0x8cb9eb);

  private lights = new Map<number, THREE.PointLight | THREE.SpotLight>();
  private markers = new THREE.Group();
  private nextLightId = 1;

  private keys = new Set<string>();
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();

  onPlace: ((point: THREE.Vector3) => void) | null = null;
  placing = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 4000);
    this.camera.position.set(15, 10, 15);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target, this.hemi, this.markers);

    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    canvas.addEventListener("pointerdown", (e) => {
      if (!this.placing || !this.model || e.button !== 0) return;
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      );
      this.raycaster.setFromCamera(ndc, this.camera);
      const hits = this.raycaster.intersectObject(this.model, true);
      if (hits.length) {
        // Nudge toward the camera — face normals in .skp content are
        // unreliable, but "toward the viewer" always lands inside the room.
        const p = hits[0].point.clone();
        const toCam = this.camera.position.clone().sub(p).normalize();
        p.addScaledVector(toCam, 0.2);
        this.onPlace?.(p);
      }
    });

    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 800;
    const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.flyStep(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** WASD/QE flight + arrow-key panning, relative to the camera; shift = 4x speed. */
  private flyStep(dt: number) {
    if (!this.keys.size) return;
    const size = this.modelBox.isEmpty() ? 20 : this.modelBox.getSize(new THREE.Vector3()).length();
    let speed = size * 0.08 * dt;
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) speed *= 4;

    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    const move = new THREE.Vector3();
    if (this.keys.has("KeyW")) move.add(fwd);
    if (this.keys.has("KeyS")) move.sub(fwd);
    if (this.keys.has("KeyD")) move.add(right);
    if (this.keys.has("KeyA")) move.sub(right);
    if (this.keys.has("KeyE")) move.y += 1;
    if (this.keys.has("KeyQ")) move.y -= 1;
    if (move.lengthSq() > 0) move.normalize();

    // Arrow keys: screen-space pan (truck/pedestal) at 1/3 speed for
    // precise framing — slides the view without changing the look direction.
    const screenUp = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const pan = new THREE.Vector3();
    if (this.keys.has("ArrowRight")) pan.add(right);
    if (this.keys.has("ArrowLeft")) pan.sub(right);
    if (this.keys.has("ArrowUp")) pan.add(screenUp);
    if (this.keys.has("ArrowDown")) pan.sub(screenUp);
    if (pan.lengthSq() > 0) move.addScaledVector(pan.normalize(), 1 / 3);

    if (move.lengthSq() === 0) return;
    move.multiplyScalar(speed);
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  /** Load model.obj / model.mtl from a base (asset URL dir or http base). */
  async load(resolveUrl: (rel: string) => string): Promise<{ triangles: number }> {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mat) => {
            const sm = mat as THREE.MeshPhongMaterial;
            sm.map?.dispose();
            sm.dispose();
          });
        }
      });
      this.model = null;
    }

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (/^(https?:|blob:|data:|asset:|tauri:)/.test(url)) return url;
      return resolveUrl(url.replace(/^\.\//, ""));
    });

    const mtl = await new MTLLoader(manager).loadAsync("model.mtl");
    mtl.preload();
    const obj = await new OBJLoader(manager).setMaterials(mtl).loadAsync("model.obj");

    let triangles = 0;
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      triangles += (mesh.geometry.getAttribute("position")?.count ?? 0) / 3;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((mat) => {
        const m = mat as THREE.MeshPhongMaterial;
        m.side = THREE.DoubleSide;
        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
        if (m.transparent && m.opacity > 0.98) m.transparent = false;
      });
    });

    this.model = obj;
    this.scene.add(obj);
    this.modelBox.setFromObject(obj);
    this.fitSunShadow();
    return { triangles: Math.round(triangles) };
  }

  frameModel() {
    if (this.modelBox.isEmpty()) return;
    const c = this.modelBox.getCenter(new THREE.Vector3());
    const s = this.modelBox.getSize(new THREE.Vector3());
    const d = Math.max(s.x, s.y, s.z);
    this.camera.position.set(c.x + d * 0.5, c.y + d * 0.35, c.z + d * 0.5);
    this.controls.target.copy(c);
    this.controls.update();
  }

  private fitSunShadow() {
    if (this.modelBox.isEmpty()) return;
    const s = this.modelBox.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.z) * 0.75;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = r * 6;
    cam.updateProjectionMatrix();
  }

  setTimeOfDay(t: number) {
    const d = daylightAt(t);
    this.sun.intensity = d.sunIntensity;
    this.sun.color.set(d.sunColor);
    this.sun.visible = d.sunIntensity > 0.01;
    this.hemi.color.set(d.hemiSky);
    this.hemi.groundColor.set(d.hemiGround);
    this.hemi.intensity = d.hemiIntensity;
    this.bgColor.set(d.background);
    if (!this.skyTexture) this.scene.background = this.bgColor;

    const c = this.modelBox.isEmpty()
      ? new THREE.Vector3()
      : this.modelBox.getCenter(new THREE.Vector3());
    const dist = this.modelBox.isEmpty()
      ? 50
      : this.modelBox.getSize(new THREE.Vector3()).length();
    const el = THREE.MathUtils.degToRad(Math.max(d.elevationDeg, 2));
    const az = THREE.MathUtils.degToRad(d.azimuthDeg);
    this.sun.position.set(
      c.x + dist * Math.cos(el) * Math.sin(az),
      c.y + dist * Math.sin(el),
      c.z + dist * Math.cos(el) * Math.cos(az)
    );
    this.sun.target.position.copy(c);
  }

  setExposure(v: number) {
    this.renderer.toneMappingExposure = v;
  }

  async setSkyImage(url: string | null) {
    this.skyTexture?.dispose();
    this.skyTexture = null;
    if (!url) {
      this.scene.background = this.bgColor;
      return;
    }
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.skyTexture = tex;
    this.scene.background = tex;
  }

  // ---- point & window lights ----

  addLight(def: Omit<PointLightDef, "id"> & { id?: number }): PointLightDef {
    const id = def.id ?? this.nextLightId++;
    if (id >= this.nextLightId) this.nextLightId = id + 1;
    const full: PointLightDef = { ...def, id };

    let light: THREE.PointLight | THREE.SpotLight;
    let marker: THREE.Mesh;
    if (def.kind === "window") {
      // Wide, soft spotlight = light shafting in through a window. SpotLight
      // (unlike RectAreaLight) works with the Phong materials MTL loading
      // produces, and can cast shadows.
      const spot = new THREE.SpotLight(def.color, def.intensity, 0, Math.PI / 2.6, 1, 1.4);
      spot.position.set(...def.position);
      spot.target.position.set(...(def.target ?? [0, 0, 0]));
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.bias = -0.002;
      this.scene.add(spot.target);
      light = spot;
      marker = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6, 1.3),
        new THREE.MeshBasicMaterial({ color: def.color, wireframe: true })
      );
      marker.position.copy(spot.position);
      marker.lookAt(spot.target.position);
    } else {
      const point = new THREE.PointLight(def.color, def.intensity, 0, 2);
      point.position.set(...def.position);
      point.castShadow = this.lights.size < 4; // cap shadow-casting lights for perf
      if (point.castShadow) point.shadow.mapSize.set(512, 512);
      light = point;
      marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 12, 8),
        new THREE.MeshBasicMaterial({ color: def.color })
      );
      marker.position.copy(point.position);
    }
    this.scene.add(light);
    marker.name = `marker-${id}`;
    this.markers.add(marker);

    this.lights.set(id, light);
    return full;
  }

  updateLight(def: PointLightDef) {
    const light = this.lights.get(def.id);
    if (!light) return;
    light.color.set(def.color);
    light.intensity = def.intensity;
    light.position.set(...def.position);
    if (def.kind === "window" && def.target && (light as THREE.SpotLight).isSpotLight) {
      (light as THREE.SpotLight).target.position.set(...def.target);
    }
    const marker = this.markers.getObjectByName(`marker-${def.id}`) as THREE.Mesh | undefined;
    if (marker) {
      marker.position.copy(light.position);
      if (def.kind === "window" && def.target) marker.lookAt(...def.target);
      (marker.material as THREE.MeshBasicMaterial).color.set(def.color);
    }
  }

  /** Replace all lights with the given defs (used by undo restore). */
  syncLights(defs: PointLightDef[]) {
    this.clearLights();
    defs.forEach((d) => this.addLight(d));
  }

  removeLight(id: number) {
    const light = this.lights.get(id);
    if (!light) return;
    this.scene.remove(light);
    if ((light as THREE.SpotLight).isSpotLight) this.scene.remove((light as THREE.SpotLight).target);
    light.dispose();
    this.lights.delete(id);
    const marker = this.markers.getObjectByName(`marker-${id}`);
    if (marker) this.markers.remove(marker);
  }

  clearLights() {
    [...this.lights.keys()].forEach((id) => this.removeLight(id));
  }

  setMarkersVisible(v: boolean) {
    this.markers.visible = v;
  }

  // ---- camera bookmarks ----

  getCameraState(): Omit<CameraBookmark, "name"> {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
      fov: this.camera.fov,
    };
  }

  applyCameraState(b: Omit<CameraBookmark, "name">) {
    this.camera.position.set(...b.position);
    this.controls.target.set(...b.target);
    this.camera.fov = b.fov;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setFov(fov: number) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** Render at multiplier x current size, return PNG base64 (no data: prefix). */
  capture(multiplier: number): string {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const wasVisible = this.markers.visible;
    this.markers.visible = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w * multiplier, h * multiplier, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const data = canvas.toDataURL("image/png").split(",")[1];
    this.markers.visible = wasVisible;
    this.resize();
    return data;
  }
}
