import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

export function createViewer(container, part) {
  const names = Object.keys(part.parts);

  // --- renderer / scene / camera --------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

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
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.6;

  // --- lights + grid --------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202024, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(8, 14, 10);
  scene.add(key);
  // 1 cm grid (mm units): 200 mm wide, 20 divisions -> 10 mm squares.
  let grid = new THREE.GridHelper(200, 20, THEME.dark.grid[0], THEME.dark.grid[1]);
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
  for (const m of Object.values(subMesh)) {
    m.visible = false;
    partsGroup.add(m);
  }

  // CAD-style feature edge lines (anti-aliased "fat" lines), one per sub-part.
  const EDGE_ANGLE = 35; // deg — OCCT fallback threshold (Manifold supplies seam-aware edges)
  const lineMaterial = new LineMaterial({ color: 0x1c232d, linewidth: 1.0 }); // ~10% lighter, 1 px
  lineMaterial.resolution.set(innerWidth, innerHeight);
  const subLines = Object.fromEntries(
    names.map((n) => [n, new LineSegments2(new LineSegmentsGeometry(), lineMaterial)])
  );
  for (const l of Object.values(subLines)) {
    l.visible = false;
    partsGroup.add(l);
  }

  // Smooth shading within CREASE_ANGLE of a shared edge, hard edge past it — so the
  // round body and helical groove read smooth while bore rims, drum faces, and
  // groove walls stay crisp. Lower = more hard edges; raise toward Math.PI/3 for
  // softer. (Worker normals are ignored; we recompute per the crease threshold.)
  const CREASE_ANGLE = Math.PI / 6; // 30°

  // --- geometry builder -----------------------------------------------------
  // BufferGeometry from a worker mesh payload — kept in its shared-frame coords
  // (NOT recentred) so the pieces assemble in the right relative positions.
  function buildGeometry({ positions, normals, indices, triangles, edges }) {
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
    subCache[name] = buildGeometry(payload);
  }

  // --- show / hide assembly -------------------------------------------------
  const _box = new THREE.Box3();

  // Recentre the assembly on the pivot and frame the camera to the named parts.
  function frameTo(visibleNames) {
    _box.makeEmpty();
    for (const name of visibleNames) if (subCache[name]) _box.union(subCache[name].boundingBox);
    if (_box.isEmpty()) return;
    const center = _box.getCenter(new THREE.Vector3());
    partsGroup.position.copy(center).multiplyScalar(-1); // centre assembly on the pivot
    const size = _box.getSize(new THREE.Vector3());
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
  }

  // Re-frame whatever is currently visible (the reframe button).
  function frame() {
    frameTo(names.filter((n) => subMesh[n].visible && subCache[n]));
  }

  function setAutoRotate(on) { controls.autoRotate = on; }

  // Swap the scene background, grid, and edge-line colors for the given theme.
  function setTheme(mode) {
    const t = THEME[mode] ?? THEME.dark;
    scene.background = new THREE.Color(t.bg);
    scene.remove(grid);
    grid = new THREE.GridHelper(200, 20, t.grid[0], t.grid[1]);
    scene.add(grid);
    lineMaterial.color.set(t.line);
  }

  function hideAssembly() {
    for (const m of Object.values(subMesh)) m.visible = false;
    for (const l of Object.values(subLines)) l.visible = false;
  }

  // --- resize ---------------------------------------------------------------
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    lineMaterial.resolution.set(w, h); // fat lines need the viewport size for px width
  }
  addEventListener("resize", resize);
  resize();

  // --- render loop ----------------------------------------------------------
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  // --- dispose --------------------------------------------------------------
  function dispose() {
    renderer.setAnimationLoop(null);
    renderer.dispose();
    container.removeChild(renderer.domElement);
  }

  return { showAssembly, hideAssembly, setSubGeometry, resize, dispose, frame, setAutoRotate, setTheme, _subCache: subCache };
}
