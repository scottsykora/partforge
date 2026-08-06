import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { createCutaway } from "./cutaway.js";
import { createCameraTween } from "./camera-tween.js";
import { addViewerLights, captureLightPoses, createCaptureLights } from "./viewer-lighting.js";
import { CANONICAL_VIEWS, cameraPoseForView } from "./view-angles.js";

// three renders into a render target in the LINEAR working colour space: as of r184
// WebGLRenderer only applies `outputColorSpace` on the canvas path (WebGLPrograms
// substitutes workingColorSpace whenever a render target is bound), so readback pixels
// are linear no matter what the target texture's colorSpace says. Writing them straight
// into a JPEG is what made captured views come back muddy and dark compared to the live
// canvas. Encode the transfer function ourselves. The 8-bit LUT loses precision only in
// the deepest shadows, which a quality-0.9 JPEG would not have preserved anyway.
const SRGB8 = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const l = i / 255;
    table[i] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));
  }
  return table;
})();

// Linear RGBA bytes → sRGB, in place. Alpha is a coverage value, not a colour: untouched.
export function srgbEncodeInPlace(data) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = SRGB8[data[i]];
    data[i + 1] = SRGB8[data[i + 1]];
    data[i + 2] = SRGB8[data[i + 2]];
  }
  return data;
}

// Render a set of canonical views without disturbing the live camera/canvas.
// `renderer.renderOffscreen(pose)` does the GL work (temp camera → offscreen
// target → readback → JPEG data URL); injected so this is unit-testable without
// a GL context. The grid is hidden for the whole synchronous pass and restored.
export function captureViewsFromScene(viewNames, { renderer, liveCamera, grid, bounds }) {
  const views = (viewNames?.length ? viewNames : ["iso", "front", "top"])
    .filter((v) => CANONICAL_VIEWS.includes(v))
    .slice(0, CANONICAL_VIEWS.length);
  const before = liveCamera.position.clone();
  const gridWasVisible = grid?.visible;
  if (grid) grid.visible = false;
  try {
    return views.map((view) => ({
      view,
      dataUrl: renderer.renderOffscreen(cameraPoseForView(view, bounds)),
    }));
  } finally {
    if (grid) grid.visible = gridWasVisible;
    liveCamera.position.copy(before); // belt-and-suspenders: never leak camera state
  }
}

// Render the LIVE camera's current framing offscreen, once, at a caller-chosen
// resolution — the showcase capture behind the runtime handle's captureCurrent.
// Same injected-renderer split as captureViewsFromScene so it runs without a GL
// context: pose comes from the live camera (never a canonical pose), the output
// long edge is `size` clamped into [256, maxTextureSize], and the short edge
// follows the live camera's aspect so the capture matches what the user framed.
export function captureCurrentFromScene(
  { size = 2048, hideGrid = true, quality = 0.9 } = {},
  { renderer, liveCamera, target, grid, maxTextureSize },
) {
  const MIN_SIZE = 256;
  // WebGL2 guarantees MAX_TEXTURE_SIZE >= 2048; only trust a larger reported cap.
  const long = Math.min(Math.max(Math.round(size) || MIN_SIZE, MIN_SIZE), maxTextureSize ?? 2048);
  const aspect = liveCamera.aspect || 1;
  const width = aspect >= 1 ? long : Math.max(1, Math.round(long * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(long / aspect)) : long;
  const before = liveCamera.position.clone();
  const gridWasVisible = grid?.visible;
  if (grid && hideGrid) grid.visible = false;
  try {
    return renderer.renderOffscreen(
      { position: liveCamera.position.toArray(), up: liveCamera.up.toArray(), target },
      { width, height, fov: liveCamera.fov, quality },
    );
  } finally {
    if (grid && hideGrid) grid.visible = gridWasVisible;
    liveCamera.position.copy(before); // belt-and-suspenders: never leak camera state
  }
}

export function createViewer(container, part) {
  const names = Object.keys(part.parts);

  // --- renderer / scene / camera --------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Declared up here, not beside setActive() below, because the initial resize()
  // runs during construction and reads it.
  let active = true;

  const scene = new THREE.Scene();

  // Light/dark scene palettes (the page chrome is themed separately, via CSS on the
  // host page). A part can override the dark background through meta.background.
  const THEME = {
    dark:  { bg: part.meta?.background ?? 0x15181d, grid: [0x2c333d, 0x222831], line: 0x1c232d },
    light: { bg: 0xe9edf2, grid: [0xc4ccd6, 0xd6dce4], line: 0x33414f },
  };
  scene.background = new THREE.Color(THEME.dark.bg);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(18, 12, 18);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // --- lights + grid --------------------------------------------------------
  const liveLights = addViewerLights(scene);
  // 1 cm grid (mm units): 300 mm wide, 30 divisions -> 10 mm (1 cm) squares.
  const GRID_SIZE = 300, GRID_DIVS = 30;
  let floorY = 0; // world Y of the grid plane; set to the part's bbox bottom in frameTo
  let grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVS, THEME.dark.grid[0], THEME.dark.grid[1]);
  scene.add(grid);

  // --- material + part groups -----------------------------------------------
  const material = new THREE.MeshStandardMaterial({
    color: 0x9fb4cc,
    metalness: 0.25,
    roughness: 0.55,
    flatShading: false,
    polygonOffset: true, // push the surface back so edge lines sit cleanly on top
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  // Sub-parts are meshed independently in a shared frame and cached, so any view
  // is composed from cached pieces. `pivot` stands the part's Z axis up (parts are
  // modelled Z-up; this faces the camera); `partsGroup` is recentred per view so
  // the visible assembly sits at the origin.
  const pivot = new THREE.Group();
  pivot.rotation.x = -Math.PI / 2; // model Z (CAD up) -> vertical
  scene.add(pivot);
  const partsGroup = new THREE.Group();
  pivot.add(partsGroup);

  // Per-sub-part material: parts share the default material unless they declare
  // `display: { color?, opacity? }` (e.g. a reference/ghost part shown in a
  // distinct colour and/or semi-transparent so it reads as "not a printed part").
  function materialFor(name) {
    const disp = part.parts[name].display;
    if (!disp || (disp.color == null && disp.opacity == null)) return material;
    const m = material.clone();
    if (disp.color != null) m.color = new THREE.Color(disp.color);
    if (disp.opacity != null && disp.opacity < 1) { m.transparent = true; m.opacity = disp.opacity; m.depthWrite = false; }
    return m;
  }

  const subMesh = Object.fromEntries(
    names.map((n) => [n, new THREE.Mesh(new THREE.BufferGeometry(), materialFor(n))])
  );
  for (const [n, m] of Object.entries(subMesh)) {
    m.name = n;
    m.visible = false;
    partsGroup.add(m);
  }

  // CAD-style feature edge lines (anti-aliased "fat" lines), one per sub-part.
  const EDGE_ANGLE = 35; // deg — OCCT fallback threshold (Manifold supplies seam-aware edges)
  const lineMaterial = new LineMaterial({ color: THEME.dark.line, linewidth: 1.0 }); // ~10% lighter, 1 px
  lineMaterial.resolution.set(1, 1); // real size set by resize() below
  const subLines = Object.fromEntries(
    names.map((n) => [n, new LineSegments2(new LineSegmentsGeometry(), lineMaterial)])
  );
  for (const l of Object.values(subLines)) {
    l.visible = false;
    partsGroup.add(l);
  }

  // The cutaway plane lives in world space, so its initial/reset bounds must
  // include the pivot rotation and the per-view recentering transform —
  // mesh.matrixWorld carries both. Union each visible mesh's own
  // geometry.boundingBox rather than `Box3.expandByObject`, which recurses into
  // children: the two stencil-pass meshes share `mesh.geometry` so that
  // recursion is harmless for them, but the cut-face outline child carries its
  // own independent geometry that only re-slices while the cutaway is enabled
  // and visible — while hidden it can keep segments from an older, larger part
  // and inflate these bounds. A subpart's initial placeholder BufferGeometry
  // has no boundingBox computed (only buildGeometry computes one), so skip it.
  const _worldBounds = new THREE.Box3();
  const _meshBounds = new THREE.Box3();
  function getVisibleWorldBounds() {
    _worldBounds.makeEmpty();
    for (const mesh of Object.values(subMesh)) {
      if (!mesh.visible || !mesh.geometry?.boundingBox) continue;
      mesh.updateWorldMatrix(true, false);
      _meshBounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      _worldBounds.union(_meshBounds);
    }
    return _worldBounds;
  }

  const cutaway = createCutaway({
    renderer,
    scene,
    camera,
    orbitControls: controls,
    domElement: renderer.domElement,
    getBounds: getVisibleWorldBounds,
    edgeColor: THEME.dark.line,
  });
  for (const name of names) {
    cutaway.setSubpart(name, subMesh[name], subLines[name]);
  }

  // --- animation hooks --------------------------------------------------------
  // Frame listeners get dt (seconds, clamped so a background-tab return doesn't
  // fast-forward playback) inside the render loop — so a parked viewer
  // (setActive(false)) automatically halts playback too: no loop, no ticks.
  const frameListeners = new Set();
  function onFrame(cb) { frameListeners.add(cb); return () => frameListeners.delete(cb); }

  const camTween = createCameraTween();
  // Tween the orbit camera to a canonical angle, framed on what's visible now.
  // Presentational only; a caller passing duration 0 gets a jump cut.
  function tweenCameraTo(viewName, { duration = 0.6, onComplete } = {}) {
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) { onComplete?.(); return; }
    const center = box.getCenter(new THREE.Vector3()).toArray();
    const size = box.getSize(new THREE.Vector3());
    // radius = full max extent (not half), matching frameTo's framing distance so a
    // live camera cue doesn't land twice as close as the reframe button and crop the part.
    const pose = cameraPoseForView(viewName, { center, radius: Math.max(size.x, size.y, size.z) || 12 });
    camTween.start(
      { position: camera.position.toArray(), target: controls.target.toArray() },
      { position: pose.position, target: pose.target },
      { duration, onComplete },
    );
  }
  const cancelCameraTween = () => camTween.cancel();

  // User grabbing the orbit cancels any cue tween (the user owns the camera) and
  // tells subscribers (the animation driver disarms remaining cues).
  const cameraStartListeners = new Set();
  const onControlsStart = () => { camTween.cancel(); for (const cb of [...cameraStartListeners]) cb(); };
  controls.addEventListener("start", onControlsStart);
  function onCameraStart(cb) { cameraStartListeners.add(cb); return () => cameraStartListeners.delete(cb); }

  // Smooth shading within CREASE_ANGLE of a shared edge, hard edge past it — so the
  // round body and helical groove read smooth while bore rims, drum faces, and
  // groove walls stay crisp. Lower = more hard edges; raise toward Math.PI/3 for
  // softer. (Worker normals are ignored; we recompute per the crease threshold.)
  const CREASE_ANGLE = Math.PI / 6; // 30°

  // --- geometry builder -----------------------------------------------------
  // BufferGeometry from a worker mesh payload — kept in its shared-frame coords
  // (NOT recentred) so the pieces assemble in the right relative positions.
  function buildGeometry({ positions, normals, indices, triangles, edges, featureIds, features }) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (indices?.length) geo.setIndex(new THREE.BufferAttribute(indices, 1)); // Manifold is non-indexed
    const triCount = triangles ?? (indices ? indices.length : positions.length / 3) / 3;
    let out;
    if (normals?.length) {
      // kernel-computed normals (Manifold) — smooth within a surface, hard at cut seams
      geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      geo.computeBoundingBox();
      out = geo;
    } else {
      // fallback (no kernel normals, e.g. OCCT): crease from the triangle soup
      out = toCreasedNormals(geo, CREASE_ANGLE);
      out.computeBoundingBox();
    }
    out.userData.triangles = triCount;
    if (featureIds) { out.userData.featureIds = featureIds; out.userData.features = features; }
    // feature edge lines: Manifold supplies seam-aware segments; else derive by angle
    const lg = new LineSegmentsGeometry();
    if (edges?.length) lg.setPositions(edges);
    else lg.fromEdgesGeometry(new THREE.EdgesGeometry(out, EDGE_ANGLE));
    out.userData.edges = lg;
    return out;
  }

  // --- sub-part geometry cache ----------------------------------------------
  const subCache = Object.fromEntries(names.map((n) => [n, null]));

  function setSubGeometry(name, payload) {
    setSubPose(name, null); // fresh worker mesh is baked at current params — clear any fast-path pose
    const prev = subCache[name];
    const next = buildGeometry(payload);
    subCache[name] = next;
    // Section helpers must stop referring to the old buffers before those
    // buffers are released.
    cutaway.updateGeometry(name, next);
    if (prev) { prev.userData.edges?.dispose(); prev.dispose(); }
  }

  // Presentational rigid pose for one sub-part (the pose fast path): applied to
  // the mesh and its edge lines. `null` clears. Column-major mat16 (pose.js /
  // three.js Matrix4 convention). Never affects exports or geometry — the worker
  // owns real placement; this only re-poses the delivered mesh.
  function setSubPose(name, mat16) {
    for (const obj of [subMesh[name], subLines[name]]) {
      if (!obj) continue;
      obj.matrixAutoUpdate = false;
      if (mat16) obj.matrix.fromArray(mat16);
      else obj.matrix.identity();
      obj.matrixWorldNeedsUpdate = true;
    }
  }

  // Cache queries for the app's regenerate loop (so it never reaches into subCache).
  const hasSubMesh = (name) => !!subCache[name];
  const subTriangles = (name) => subCache[name]?.userData.triangles ?? 0;

  // --- show / hide assembly -------------------------------------------------
  const _box = new THREE.Box3();
  const _posedBox = new THREE.Box3();

  // Recentre the assembly on the pivot and frame the camera to the named parts.
  // Cached bounding boxes are in the delivered mesh's own frame, so any fast-path
  // pose has to be applied before the union or framing ignores the re-posing.
  function frameTo(visibleNames) {
    _box.makeEmpty();
    for (const name of visibleNames) {
      if (!subCache[name]) continue;
      _posedBox.copy(subCache[name].boundingBox).applyMatrix4(subMesh[name].matrix);
      _box.union(_posedBox);
    }
    if (_box.isEmpty()) return;
    const center = _box.getCenter(new THREE.Vector3());
    partsGroup.position.copy(center).multiplyScalar(-1); // centre assembly on the pivot
    const size = _box.getSize(new THREE.Vector3());
    // Drop the grid to the bottom of the bounding box (model Z -> world Y), so it reads
    // as a floor the part sits on rather than a plane through its middle.
    floorY = -size.z / 2;
    grid.position.y = floorY;
    const r = Math.max(size.x, size.y, size.z) || 12;
    camera.position.setLength(r * 2.6 + 6);
    controls.target.set(0, 0, 0);
  }

  // Show exactly the named sub-parts (from the cache). When `frame` is set, also
  // frame the camera to them — done only on the initial show and on view (tab)
  // changes, NOT on regeneration, so a user's zoom/orbit survives editing params.
  function showAssembly(visibleNames, { frame = false } = {}) {
    for (const [name, mesh] of Object.entries(subMesh)) {
      const on = visibleNames.includes(name);
      if (on) {
        mesh.geometry = subCache[name]; // cached geometries reused, not disposed
        subLines[name].geometry = subCache[name].userData.edges;
      }
      mesh.visible = on;
      subLines[name].visible = on;
    }
    if (frame) frameTo(visibleNames);
    cutaway.setVisible(visibleNames);
  }

  // Re-frame whatever is currently visible (the reframe button).
  function frame() {
    frameTo(names.filter((n) => subMesh[n].visible && subCache[n]));
  }

  function setCutawayEnabled(on) {
    return cutaway.setEnabled(on);
  }

  // Swap the scene background, grid, and edge-line colors for the given theme.
  function setTheme(mode) {
    const t = THEME[mode] ?? THEME.dark;
    scene.background = new THREE.Color(t.bg);
    scene.remove(grid);
    grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVS, t.grid[0], t.grid[1]);
    grid.position.y = floorY; // keep the floor at the bbox bottom across theme swaps
    scene.add(grid);
    lineMaterial.color.set(t.line);
    cutaway.setTheme(mode, t.line);
  }

  function hideAssembly() {
    for (const m of Object.values(subMesh)) m.visible = false;
    for (const l of Object.values(subLines)) l.visible = false;
    cutaway.setVisible([]);
  }

  // --- resize ---------------------------------------------------------------
  // Size from the host container (not the window) so embedders control the pane.
  function resize() {
    // Parked (see setActive): the buffer is deliberately 1x1 and must stay that
    // way. iOS fires resizes constantly as the URL bar collapses, and every one
    // of them would otherwise re-allocate a full MSAA buffer for a hidden pane.
    if (!active) return;
    const w = container.clientWidth || 300, h = container.clientHeight || 150;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    lineMaterial.resolution.set(w, h); // fat lines need the viewport size for px width
    cutaway.setViewportSize(w, h, renderer.getPixelRatio());
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // --- offscreen canonical-view capture -------------------------------------
  // Offscreen render of the shared scene from an arbitrary pose → JPEG data URL.
  // A separate WebGLRenderTarget + temp camera means the visible canvas and the
  // live `camera` are never touched. WebGL pixels are bottom-up, so flip on encode.
  //
  // These captures are read by a model, not shown as a thumbnail (partforge-cloud's
  // render_part_views tool feeds them straight to the agent), so they are sized and lit
  // for reading small features: 1024² is the largest square that fits Anthropic's
  // ~1.15 MP no-downscale budget, 4× MSAA keeps a thin wall from aliasing into noise,
  // and the light rig follows the camera so no view is a flat silhouette.
  const _rtSize = 1024;
  let _rt = null;
  let _capLights = null;
  // Defaults reproduce the canonical-view capture exactly (1024² cached target,
  // fov 45, quality 0.9). A custom size (captureCurrent) gets a fresh render
  // target, disposed after the read — those captures are rare, so per-call
  // allocation beats caching one target per size ever requested.
  //
  // stencilBuffer is NOT optional: cutaway masks its section caps with the
  // stencil buffer, and a WebGLRenderTarget defaults to not having one (the
  // visible canvas does, via the `stencil: true` renderer above). Without it
  // the mask silently no-ops and every cap floods its whole plane with hatch —
  // no error, live view unaffected, wrong only in the capture.
  const RT_OPTIONS = { samples: 4, stencilBuffer: true };
  function renderOffscreen({ position, up, target },
                           { width = _rtSize, height = _rtSize, fov = 45, quality = 0.9 } = {},
                           renderScene = scene) {
    const cachedSize = width === _rtSize && height === _rtSize;
    const rt = cachedSize
      ? (_rt = _rt ?? new THREE.WebGLRenderTarget(_rtSize, _rtSize, RT_OPTIONS))
      : new THREE.WebGLRenderTarget(width, height, RT_OPTIONS);
    _capLights = _capLights ?? createCaptureLights();
    const cam = new THREE.PerspectiveCamera(fov, width / height, 0.1, 1000);
    cam.position.set(position[0], position[1], position[2]);
    cam.up.set(up[0], up[1], up[2]);
    cam.lookAt(target[0], target[1], target[2]);
    const buf = new Uint8Array(width * height * 4);
    // Swap the world-fixed key/fill for the camera-relative pair, for this one render
    // only. A DirectionalLight aims at its `target`, whose matrixWorld only updates
    // while it is in the scene graph, so both go in and both come back out.
    const poses = captureLightPoses({ position, up, target });
    const { key: capKey, fill: capFill } = _capLights;
    capKey.position.set(poses.key[0], poses.key[1], poses.key[2]);
    capFill.position.set(poses.fill[0], poses.fill[1], poses.fill[2]);
    for (const light of [capKey, capFill]) light.target.position.set(target[0], target[1], target[2]);
    liveLights.key.visible = false;
    liveLights.fill.visible = false;
    scene.add(capKey, capKey.target, capFill, capFill.target);
    try {
      renderer.setRenderTarget(rt);
      renderer.render(renderScene, cam);
      // render() resolves the multisample renderbuffer into the target texture, so this
      // reads antialiased pixels.
      renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
    } finally {
      // Never leave the user's own view unlit or pointed at the offscreen target.
      renderer.setRenderTarget(null);
      scene.remove(capKey, capKey.target, capFill, capFill.target);
      liveLights.key.visible = true;
      liveLights.fill.visible = true;
      if (!cachedSize) rt.dispose();
    }
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(width, height);
    // flip rows (GL origin is bottom-left)
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * width * 4;
      img.data.set(buf.subarray(src, src + width * 4), y * width * 4);
    }
    srgbEncodeInPlace(img.data);
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/jpeg", quality);
  }

  // Render the canonical camera angles offscreen, framed to whatever is visible,
  // without disturbing the user's live view. Returns [{ view, dataUrl }].
  function captureCanonicalViews(viewNames) {
    if (disposed) return [];
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) return [];
    const center = box.getCenter(new THREE.Vector3()).toArray();
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) / 2 || 10;
    return captureViewsFromScene(viewNames, {
      renderer: { renderOffscreen },
      liveCamera: camera,
      grid,
      bounds: { center, radius },
    });
  }

  // One offscreen render of the user's CURRENT framing (live camera pose +
  // orbit target, live aspect) at a caller-chosen resolution — the showcase
  // capture. Returns a JPEG data URL, or null when disposed / nothing visible.
  function captureCurrent(opts) {
    if (disposed) return null;
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) return null;
    return captureCurrentFromScene(opts, {
      renderer: { renderOffscreen },
      liveCamera: camera,
      target: controls.target.toArray(),
      grid,
      maxTextureSize: renderer.capabilities?.maxTextureSize,
    });
  }

  // Offscreen render of an arbitrary mesh set (a non-active view), for thumbnails.
  // Assembles a THROWAWAY scene mirroring the live pivot convention, frames it from a
  // canonical angle, renders through the parameterized renderOffscreen, and disposes
  // everything. Never touches the live scene, camera, subMesh, or subCache. `payloads`
  // is the worker's [{name, positions, normals, indices, …}] array — placement is
  // already baked into shared-frame coords, so meshes are NOT recentred.
  function renderMeshPayloads(payloads, { angle = "iso", size = 640, quality = 0.8 } = {}) {
    const tmpScene = new THREE.Scene();
    const tmpPivot = new THREE.Group();
    tmpPivot.rotation.x = -Math.PI / 2; // model Z (CAD up) -> vertical, same as live pivot
    tmpScene.add(tmpPivot);

    const built = [];
    const box = new THREE.Box3();
    for (const payload of payloads) {
      const geo = buildGeometry(payload); // shared-frame coords, NOT recentred
      const mesh = new THREE.Mesh(geo, materialFor(payload.name));
      tmpPivot.add(mesh);
      built.push(mesh);
      geo.computeBoundingBox();
      box.union(geo.boundingBox);
    }
    const center = box.getCenter(new THREE.Vector3()).toArray();
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    const pose = cameraPoseForView(angle, { center, radius });

    // Camera-relative capture lights, in the temp scene (renderOffscreen's own capture
    // lights go in the live scene and so cannot illuminate this throwaway one).
    const capLights = createCaptureLights();
    const poses = captureLightPoses(pose);
    capLights.key.position.set(poses.key[0], poses.key[1], poses.key[2]);
    capLights.fill.position.set(poses.fill[0], poses.fill[1], poses.fill[2]);
    for (const light of [capLights.key, capLights.fill]) {
      light.target.position.set(pose.target[0], pose.target[1], pose.target[2]);
    }
    tmpScene.add(capLights.key, capLights.key.target, capLights.fill, capLights.fill.target);

    try {
      return renderOffscreen(pose, { width: size, height: size, fov: 35, quality }, tmpScene);
    } finally {
      for (const mesh of built) {
        mesh.geometry.userData.edges?.dispose();
        mesh.geometry.dispose();
        if (mesh.material !== material) mesh.material.dispose(); // clone only — never the shared singleton
      }
      capLights.key.dispose?.();
      capLights.fill.dispose?.();
    }
  }

  // --- render loop ----------------------------------------------------------
  // The tween is applied after controls.update() so the cue wins the frame, and
  // the frame listeners run before render so a playback frame draws its own pose.
  let lastFrameTime = null;
  function renderFrame(time) {
    const dt = lastFrameTime == null ? 0 : Math.min(0.1, (time - lastFrameTime) / 1000);
    lastFrameTime = time;
    controls.update();
    const tw = camTween.update(dt);
    if (tw) {
      camera.position.fromArray(tw.position);
      controls.target.fromArray(tw.target);
    }
    // Per-listener guard, because three re-arms requestAnimationFrame only AFTER
    // this callback returns (WebGLAnimation.onAnimationFrame): a listener that
    // throws would stop the rAF chain outright and freeze the viewer for good, not
    // just skip a frame. Containment belongs here rather than in every subscriber.
    for (const cb of [...frameListeners]) {
      try { cb(dt); } catch (e) { console.warn("partforge: frame listener failed", e); }
    }
    if (cutaway.isEnabled) cutaway.updateForCamera();
    renderer.render(scene, camera);
    cutaway.renderOverlay(renderer, camera);
  }
  renderer.setAnimationLoop(renderFrame);

  // --- active / parked ------------------------------------------------------
  // For a host that HIDES the viewer without unmounting it. partforge's own
  // narrow layout uses `display: none` on the stage, which zeroes clientWidth
  // and lets the ResizeObserver above collapse the buffer for free. An embedder
  // that cannot do that — partforge-cloud's phone tab bar uses
  // `visibility: hidden`, because the canvas has to keep its size for build
  // screenshots — gets no such signal: the full-resolution MSAA drawing buffer
  // stays resident and this loop keeps rendering the scene at 60fps behind an
  // invisible pane. On an iPhone that is tens of megabytes and
  // continuous GPU work nobody can see, so the host has to say so explicitly.
  //
  // Parking stops the loop and releases the drawing buffer. `setSize(1, 1,
  // false)` leaves the canvas element's CSS box alone, so the host's layout
  // does not move and the pane can be revealed again without a reflow.
  function setActive(next) {
    const want = next !== false;
    if (disposed || want === active) return;
    active = want;
    if (!active) {
      renderer.setAnimationLoop(null);
      renderer.setSize(1, 1, false);
      // The cached 1024² 4x-MSAA + stencil capture target is the other large
      // allocation here — on a phone it is comparable to the canvas itself, so
      // parking that kept it would leave half the memory behind. Dropping it
      // costs one re-allocation on the next capture, which a parked viewer
      // barely notices: the cache only ever hits on an exactly-square request,
      // and a phone's capture aspect is not square, so those captures were
      // allocating per call regardless.
      _rt?.dispose();
      _rt = null;
      return;
    }
    resize(); // rebuild the buffer at whatever size the container is now
    lastFrameTime = null; // parked time is not elapsed time — no dt jump on unpark
    renderer.setAnimationLoop(renderFrame);
  }

  // --- context loss ---------------------------------------------------------
  // Losing the WebGL context is how a memory-starved phone tells you it gave
  // up. With no handler the canvas just freezes, indistinguishable from a hang,
  // and three never re-initialises. preventDefault() is what makes the loss
  // recoverable (three's own listener re-uploads on restore); the subscribers
  // let an embedder surface it instead of showing a dead rectangle.
  const contextLostListeners = new Set();
  const onContextLostEvent = (event) => {
    event.preventDefault();
    for (const listener of [...contextLostListeners]) listener();
  };
  renderer.domElement.addEventListener("webglcontextlost", onContextLostEvent);
  function onContextLost(listener) {
    contextLostListeners.add(listener);
    return () => contextLostListeners.delete(listener);
  }

  // --- camera state (read/write for persistence; mount.js owns storage) -------
  function getCameraState() {
    return {
      pos: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
    };
  }
  function setCameraState({ pos, target }) {
    camera.position.set(pos[0], pos[1], pos[2]);
    controls.target.set(target[0], target[1], target[2]);
    controls.update();
  }
  function onCameraEnd(cb) { controls.addEventListener("end", cb); }

  // Transient marker at a world-space point — visual confirmation of a pick.
  const flashTimers = new Set();
  function flashPoint(world) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false })
    );
    dot.renderOrder = 999;
    dot.position.set(world[0], world[1], world[2]);
    scene.add(dot);
    const t = setTimeout(() => {
      flashTimers.delete(t);
      scene.remove(dot); dot.geometry.dispose(); dot.material.dispose();
    }, 1200);
    flashTimers.add(t);
  }

  // Full teardown: render loop, observers, controls, timers, GPU resources, DOM.
  // Idempotent. Cached sub-part geometries and their edge lines are freed; the
  // shared and per-part cloned materials tolerate double-dispose.
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    ro.disconnect();
    renderer.setAnimationLoop(null);
    // Embedder callbacks must not outlive teardown — a disposed viewer has no
    // context left to lose, and a surviving listener would keep the embedder's
    // closure (and whatever it captured) alive.
    renderer.domElement.removeEventListener("webglcontextlost", onContextLostEvent);
    contextLostListeners.clear();
    controls.removeEventListener("start", onControlsStart);
    cameraStartListeners.clear();
    frameListeners.clear();
    camTween.cancel();
    controls.dispose();
    for (const t of flashTimers) clearTimeout(t);
    flashTimers.clear();
    cutaway.dispose();
    for (const n of names) {
      const g = subCache[n];
      if (g) { g.userData.edges?.dispose(); g.dispose(); subCache[n] = null; }
      subMesh[n].material?.dispose();
      subMesh[n].geometry?.dispose(); // the initial empty BufferGeometry, if never replaced
    }
    material.dispose();
    lineMaterial.dispose();
    grid.geometry.dispose();
    grid.material.dispose();
    _rt?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    showAssembly,
    hideAssembly,
    setSubGeometry,
    setSubPose,
    hasSubMesh,
    subTriangles,
    frame,
    captureCanonicalViews,
    captureCurrent,
    renderMeshPayloads,
    onFrame,
    tweenCameraTo,
    cancelCameraTween,
    onCameraStart,
    setActive,
    onContextLost,
    setTheme,
    getCameraState,
    setCameraState,
    onCameraEnd,
    camera,
    domElement: renderer.domElement,
    _subMeshes: subMesh,
    flashPoint,
    cutawaySupported: () => cutaway.isSupported,
    cutawayEnabled: () => cutaway.isEnabled,
    setCutawayEnabled,
    flipCutaway: cutaway.flip,
    resetCutaway: cutaway.reset,
    isWorldPointVisible: cutaway.isPointVisible,
    registerCutawayMaterial: cutaway.registerClippableMaterial,
    onCutawayHandleHover: cutaway.onHandleHoverChange,
    dispose,
  };
}
