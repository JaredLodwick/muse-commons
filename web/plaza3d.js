// plaza3d.js — isometric 3D restaurant view for the plaza (Three.js, vendored).
// Fixed dollhouse camera, procedural furniture, little Muse avatar characters.
// Server world (1000x620, y-down) maps to floor units: 1 unit = 50px.
import * as THREE from "./three.module.min.js";

const PX = 1 / 50; // server px -> world units
const ROOM_W = 1000 * PX; // 20
const ROOM_H = 620 * PX; // 12.4
const HX = ROOM_W / 2; // 10
const HZ = ROOM_H / 2; // 6.2
const WALL_H = 4.4;
const WALL_T = 0.6;

const REDUCED_MOTION = (() => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
})();

// Server (x, y-down) -> world (x, z). y=0 is the back wall.
export function serverToWorld(x, y) {
  return { x: (x - 500) * PX, z: (y - 310) * PX };
}

function makeCanvas(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, ...opts });
}

function box(w, h, d, mat, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

function cyl(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Warm restaurant palette, light + dark variants. Themeable materials hold
// a {light, dark} pair and are recolored by applyTheme().
const THEMES = {
  light: {
    bg: 0xe9dcc4, fog: 0xe9dcc4,
    hemiSky: 0xfff4e0, hemiGround: 0xb08d5f, hemiInt: 0.9,
    sun: 0xffe3b8, sunInt: 1.85, amb: 0xfff2e0, ambInt: 0.32,
    floor: 0xede3d2, wall: 0xf2e7d2, trim: 0xb08d5f,
    archIn: 0xe6cba6, curb: 0xd9c3a3, rug: 0xc99a7a,
  },
  dark: {
    bg: 0x141019, fog: 0x141019,
    hemiSky: 0x4a4468, hemiGround: 0x2a2118, hemiInt: 0.7,
    sun: 0xd9b98a, sunInt: 0.7, amb: 0x8a7a66, ambInt: 0.3,
    floor: 0x4a4038, wall: 0x3a3048, trim: 0x6a563e,
    archIn: 0x52405a, curb: 0x3c342c, rug: 0x6a4a52,
  },
};

export function createPlazaView(container, opts = {}) {
  const onAgentClick = opts.onAgentClick || (() => {});
  let themeName = opts.theme === "dark" ? "dark" : "light";

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.domElement.className = "p3d-canvas";
  container.appendChild(renderer.domElement);

  const labelsEl = document.createElement("div");
  labelsEl.className = "p3d-labels";
  container.appendChild(labelsEl);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(THEMES[themeName].bg);

  // Fixed dollhouse angle: high front elevation looking at the back wall.
  const FRUSTUM = 15;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 120);
  const camOffset = new THREE.Vector3(0, 20, 13.5).normalize();
  const camDist = 30;
  const camTarget = new THREE.Vector3(0, 0, -0.2);
  let camZoom = 1;
  function updateCamera() {
    camera.position.copy(camTarget).addScaledVector(camOffset, camDist);
    camera.lookAt(camTarget);
    camera.zoom = camZoom;
    camera.updateProjectionMatrix();
  }

  function fitZoom() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const aspect = w / h;
    camera.left = (-FRUSTUM * aspect) / 2;
    camera.right = (FRUSTUM * aspect) / 2;
    camera.top = FRUSTUM / 2;
    camera.bottom = -FRUSTUM / 2;
    // Fit the room (23 wide incl. walls, ~16 tall on screen with wall height).
    return Math.min((FRUSTUM * aspect) / 23.5, FRUSTUM / 16);
  }

  // Lights: warm sun through the windows + hemisphere fill + ambient +
  // invisible warm lights above the tables (no fixtures).
  const hemi = new THREE.HemisphereLight(0xfff4e0, 0xb08d5f, 0.85);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xfff2e0, 0.35);
  scene.add(amb);
  const sun = new THREE.DirectionalLight(0xffe7c4, 1.6);
  sun.position.set(-12, 16, 9); // streams in from the left windows
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -14;
  sun.shadow.camera.right = 14;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.camera.near = 2;
  sun.shadow.camera.far = 50;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
  const tableLights = [];
  for (const [lx, lz] of [[-4.6, 0], [4.6, 0], [0, 3.6]]) {
    const pl = new THREE.PointLight(0xffc98a, 12, 14, 1.8);
    pl.position.set(lx, 3.6, lz);
    scene.add(pl);
    tableLights.push(pl);
  }

  // Themeable materials registry: {mat, key} recoloured on theme change.
  const themeables = [];
  function themeMat(key, opts = {}) {
    const m = std(THEMES[themeName][key], opts);
    themeables.push({ mat: m, key });
    return m;
  }
  function applyTheme(name) {
    themeName = name === "dark" ? "dark" : "light";
    const T = THEMES[themeName];
    scene.background.set(T.bg);
    hemi.color.set(T.hemiSky);
    hemi.groundColor.set(T.hemiGround);
    hemi.intensity = T.hemiInt;
    amb.color.set(T.amb);
    amb.intensity = T.ambInt;
    sun.color.set(T.sun);
    sun.intensity = T.sunInt;
    for (const { mat, key } of themeables) {
      if (T[key] !== undefined) mat.color.set(T[key]);
    }
    if (typeof applyThemeExtra === "function") applyThemeExtra(themeName);
  }
  // Calms emissive surfaces in dark mode; assigned after those exist.
  let applyThemeExtra = null;

  const room = new THREE.Group();
  scene.add(room);

  // Floor: warm travertine tiles from a procedural canvas texture -
  // per-tile tone variation, stone speckle, faint veins, beveled grout.
  const floorTex = makeCanvas(1024, 640, (c, w, h) => {
    c.fillStyle = "#d8c6a6";
    c.fillRect(0, 0, w, h);
    const tw = 128, th = 128;
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let ty = 0; ty < h / th; ty++) {
      for (let tx = 0; tx < w / tw; tx++) {
        const v = rnd() * 14 - 7;
        const warm = rnd() * 6;
        c.fillStyle = `rgb(${238 + v + warm},${226 + v},${205 + v - warm})`;
        c.fillRect(tx * tw + 2, ty * th + 2, tw - 4, th - 4);
        // Stone speckle.
        for (let s = 0; s < 260; s++) {
          const sx = tx * tw + rnd() * tw;
          const sy = ty * th + rnd() * th;
          c.fillStyle = rnd() > 0.5 ? "rgba(160,135,100,.13)" : "rgba(255,250,238,.14)";
          c.fillRect(sx, sy, 1.6, 1.6);
        }
        // A couple of faint travertine veins per tile.
        c.strokeStyle = "rgba(170,145,110,.16)";
        c.lineWidth = 1.4;
        for (let vn = 0; vn < 2; vn++) {
          const vy = ty * th + rnd() * th;
          c.beginPath();
          c.moveTo(tx * tw, vy);
          c.bezierCurveTo(
            tx * tw + tw * 0.3, vy + rnd() * 10 - 5,
            tx * tw + tw * 0.7, vy + rnd() * 10 - 5,
            tx * tw + tw, vy + rnd() * 8 - 4
          );
          c.stroke();
        }
        // Bevel highlight along the tile's top-left edges.
        c.fillStyle = "rgba(255,252,244,.35)";
        c.fillRect(tx * tw + 2, ty * th + 2, tw - 4, 2);
        c.fillRect(tx * tw + 2, ty * th + 2, 2, th - 4);
      }
    }
  });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(3, 2);
  const floorMat = themeMat("floor", { map: floorTex, roughness: 0.95 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.add(floor);
  // Ground skirt under the dollhouse cutout.
  const skirt = box(ROOM_W + 3, 0.8, ROOM_H + 3, std(0x8a6f4d), 0, -0.42, 0, false);
  skirt.receiveShadow = true;
  room.add(skirt);

  // Central rug with a stitched border.
  const rugTex = makeCanvas(512, 512, (c, w, h) => {
    c.fillStyle = "#c99a7a";
    c.fillRect(0, 0, w, h);
    // Woven diamond lattice across the field.
    c.strokeStyle = "rgba(138,90,52,.28)";
    c.lineWidth = 2;
    const step = 42;
    for (let x = -h; x < w + h; x += step) {
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x + h, h); c.stroke();
      c.beginPath(); c.moveTo(x + h, 0); c.lineTo(x, h); c.stroke();
    }
    c.strokeStyle = "#8a5a34";
    c.lineWidth = 10;
    c.strokeRect(16, 16, w - 32, h - 32);
    c.strokeStyle = "rgba(245,230,210,.55)";
    c.lineWidth = 3;
    c.strokeRect(34, 34, w - 68, h - 68);
    c.strokeStyle = "rgba(138,90,52,.5)";
    c.lineWidth = 3;
    c.strokeRect(48, 48, w - 96, h - 96);
    c.fillStyle = "rgba(138,90,52,.8)";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      c.beginPath();
      c.arc(w / 2 + Math.cos(a) * 168, h / 2 + Math.sin(a) * 168, 6, 0, 7);
      c.fill();
    }
  });
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 4.6),
    themeMat("rug", { map: rugTex, roughness: 1 })
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.01, 0.4);
  rug.receiveShadow = true;
  room.add(rug);

  // Walls: tall back + sides, low dollhouse curb at the front.
  // Subtle plaster texture (near-white, so the theme color tints it).
  const plasterTex = makeCanvas(512, 512, (c, w, h) => {
    c.fillStyle = "#f6f1e7";
    c.fillRect(0, 0, w, h);
    let seed = 31;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 90; i++) {
      const x = rnd() * w, y = rnd() * h, r = 30 + rnd() * 90;
      const grad = c.createRadialGradient(x, y, 0, x, y, r);
      const tone = rnd() > 0.5 ? "214,198,170" : "255,252,246";
      grad.addColorStop(0, `rgba(${tone},.10)`);
      grad.addColorStop(1, `rgba(${tone},0)`);
      c.fillStyle = grad;
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    }
    for (let s = 0; s < 2600; s++) {
      c.fillStyle = rnd() > 0.5 ? "rgba(170,150,120,.05)" : "rgba(255,255,255,.06)";
      c.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
    }
  });
  plasterTex.wrapS = plasterTex.wrapT = THREE.RepeatWrapping;
  plasterTex.repeat.set(3, 1);
  const wallMat = themeMat("wall", { map: plasterTex, roughness: 0.95 });
  const trimMat = themeMat("trim", { roughness: 0.8 });
  const archInMat = themeMat("archIn", { map: plasterTex, roughness: 0.95 });
  const backWall = box(ROOM_W + 2 * WALL_T, WALL_H, WALL_T, wallMat, 0, WALL_H / 2, -HZ - WALL_T / 2);
  const leftWall = box(WALL_T, WALL_H, ROOM_H, wallMat, -HX - WALL_T / 2, WALL_H / 2, 0);
  const rightWall = box(WALL_T, WALL_H, ROOM_H, wallMat, HX + WALL_T / 2, WALL_H / 2, 0);
  room.add(backWall, leftWall, rightWall);
  const curb = box(ROOM_W + 2 * WALL_T, 0.9, WALL_T, themeMat("curb"), 0, 0.45, HZ + WALL_T / 2);
  room.add(curb);
  // Wall cap trim + baseboards.
  room.add(box(ROOM_W + 2 * WALL_T, 0.18, WALL_T + 0.15, trimMat, 0, WALL_H + 0.09, -HZ - WALL_T / 2));
  room.add(box(WALL_T + 0.15, 0.18, ROOM_H, trimMat, -HX - WALL_T / 2, WALL_H + 0.09, 0));
  room.add(box(WALL_T + 0.15, 0.18, ROOM_H, trimMat, HX + WALL_T / 2, WALL_H + 0.09, 0));
  room.add(box(ROOM_W + 2 * WALL_T, 0.22, WALL_T + 0.12, trimMat, 0, 1.0, HZ + WALL_T / 2));
  room.add(box(ROOM_W, 0.22, 0.1, trimMat, 0, 0.11, -HZ + 0.05, false));

  // Arched niches on the back wall: recessed panel + arch frame + art.
  function archNiche(x, w = 2.6, h = 3.1) {
    const g = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), archInMat);
    panel.position.set(0, h / 2 + 0.2, 0.02);
    panel.receiveShadow = true;
    g.add(panel);
    const frameMat = trimMat;
    const jamb = 0.16;
    g.add(box(jamb, h, 0.14, frameMat, -w / 2, h / 2 + 0.2, 0.06));
    g.add(box(jamb, h, 0.14, frameMat, w / 2, h / 2 + 0.2, 0.06));
    const arch = new THREE.Mesh(new THREE.TorusGeometry(w / 2, 0.09, 10, 24, Math.PI), frameMat);
    arch.position.set(0, h + 0.2, 0.06);
    arch.castShadow = true;
    g.add(arch);
    // Small framed print inside the niche.
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 0.42, h * 0.34),
      std(0xd9b98a, { roughness: 0.9 })
    );
    art.position.set(0, h * 0.55, 0.05);
    g.add(art);
    g.add(box(w * 0.42 + 0.12, h * 0.34 + 0.12, 0.04, frameMat, 0, h * 0.55, 0.03));
    g.position.set(x, 0, -HZ + 0.02);
    return g;
  }
  room.add(archNiche(-6.4), archNiche(6.4));

  // Windows on the left wall: warm glowing panes with muntins.
  const paneMat = new THREE.MeshStandardMaterial({
    color: 0xfff6e2, emissive: 0xffedb8, emissiveIntensity: 0.9, roughness: 0.4,
  });
  themeables.push({ mat: paneMat, key: "__pane" }); // handled below in applyThemeExtra
  // Arch-topped window pane: rectangle crowned by a semicircle.
  const winShape = new THREE.Shape();
  winShape.moveTo(-0.85, -1.2);
  winShape.lineTo(0.85, -1.2);
  winShape.lineTo(0.85, 0.35);
  winShape.absarc(0, 0.35, 0.85, 0, Math.PI, false);
  winShape.lineTo(-0.85, -1.2);
  const winGeo = new THREE.ShapeGeometry(winShape, 20);
  for (const wz of [-3.4, 0.2, 3.8]) {
    const g = new THREE.Group();
    const pane = new THREE.Mesh(winGeo, paneMat);
    pane.rotation.y = Math.PI / 2;
    pane.position.y = 2.3;
    g.add(pane);
    const fm = trimMat;
    g.add(box(0.12, 1.6, 0.14, fm, 0, 1.85, -0.92));
    g.add(box(0.12, 1.6, 0.14, fm, 0, 1.85, 0.92));
    const archTrim = new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.08, 8, 22, Math.PI), fm);
    archTrim.rotation.y = Math.PI / 2;
    archTrim.position.set(0, 2.65, 0);
    archTrim.castShadow = true;
    g.add(archTrim);
    g.add(box(0.12, 0.14, 1.98, fm, 0, 1.03, 0));
    g.add(box(0.1, 2.4, 0.07, fm, 0, 2.3, 0));
    g.add(box(0.1, 0.07, 1.7, fm, 0, 2.3, 0));
    g.position.set(-HX + 0.04, 0, wz);
    room.add(g);
    // Sun patch on the floor beneath each window.
    const patch = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 1.8),
      new THREE.MeshBasicMaterial({ color: 0xffe2ae, transparent: true, opacity: 0.28 })
    );
    patch.rotation.x = -Math.PI / 2;
    patch.rotation.z = 0.25;
    patch.position.set(-HX + 2.2, 0.015, wz + 0.5);
    room.add(patch);
  }

  // Garland swags along the back wall top: leaf blobs on a sagging curve.
  const leafMats = [std(0x4e8a5c), std(0x5fa06a), std(0x3e7a4e)];
  const leafGeo = new THREE.IcosahedronGeometry(0.16, 0);
  const berryMat = std(0xd9704e, { roughness: 0.6 });
  const berryGeo = new THREE.SphereGeometry(0.05, 8, 8);
  function garland(x0, x1, y, z, sag = 0.5) {
    const n = Math.max(6, Math.round((x1 - x0) / 0.35));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const x = x0 + (x1 - x0) * k;
      const yy = y - Math.sin(k * Math.PI) * sag;
      const leaf = new THREE.Mesh(leafGeo, leafMats[i % 3]);
      leaf.position.set(x, yy + (i % 2) * 0.08, z);
      leaf.scale.setScalar(0.85 + (i % 3) * 0.15);
      leaf.castShadow = true;
      room.add(leaf);
      if (i % 4 === 2) {
        const berry = new THREE.Mesh(berryGeo, berryMat);
        berry.position.set(x + 0.06, yy - 0.1, z + 0.1);
        room.add(berry);
      }
    }
  }
  garland(-HX + 0.6, -2.2, WALL_H - 0.5, -HZ + 0.25);
  garland(2.2, HX - 0.6, WALL_H - 0.5, -HZ + 0.25);

  // Arched display niches on the right wall: a recessed arch, a shelf
  // with a tiny plant or candle, and a warm glowing orb above.
  const sconceMat = new THREE.MeshStandardMaterial({
    color: 0xffe9c4, emissive: 0xffc98a, emissiveIntensity: 1.2, roughness: 0.5,
  });
  const nicheLeafMat = std(0x5fa06a);
  [-4.2, -1.4, 1.4, 4.2].forEach((sz, ni) => {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 1.9), archInMat);
    panel.rotation.y = -Math.PI / 2;
    panel.position.set(HX - 0.02, 2.45, sz);
    panel.receiveShadow = true;
    room.add(panel);
    const archTrim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 8, 20, Math.PI), trimMat);
    archTrim.rotation.y = Math.PI / 2;
    archTrim.position.set(HX - 0.06, 2.95, sz);
    room.add(archTrim);
    room.add(box(0.1, 1.5, 0.1, trimMat, HX - 0.05, 2.2, sz - 0.5, false));
    room.add(box(0.1, 1.5, 0.1, trimMat, HX - 0.05, 2.2, sz + 0.5, false));
    room.add(box(0.3, 0.05, 0.9, trimMat, HX - 0.16, 1.85, sz, false));
    if (ni % 2 === 0) {
      room.add(cyl(0.07, 0.055, 0.13, std(0xb4653f), HX - 0.16, 1.94, sz, 8));
      for (let lf = 0; lf < 3; lf++) {
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), nicheLeafMat);
        leaf.position.set(HX - 0.16 + (lf - 1) * 0.07, 2.1 + (lf % 2) * 0.05, sz + (lf - 1) * 0.08);
        leaf.castShadow = true;
        room.add(leaf);
      }
    } else {
      room.add(cyl(0.045, 0.045, 0.15, std(0xf3e8d2), HX - 0.16, 1.95, sz, 8));
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 8), sconceMat);
      flame.position.set(HX - 0.16, 2.06, sz);
      room.add(flame);
    }
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), sconceMat);
    orb.position.set(HX - 0.2, 2.72, sz);
    room.add(orb);
  });

  applyThemeExtra = (name) => {
    const dark = name === "dark";
    paneMat.emissiveIntensity = dark ? 0.35 : 0.9;
    sconceMat.emissiveIntensity = dark ? 0.9 : 1.2;
  };
  applyThemeExtra(themeName);

  // Service counter against the back wall: slatted wood front + stone top.
  const slatTex = makeCanvas(256, 128, (c, w, h) => {
    c.fillStyle = "#c98f6b";
    c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) {
      c.fillStyle = "rgba(120,70,40,.35)";
      c.fillRect(x, 0, 3, h);
      c.fillStyle = "rgba(255,235,210,.25)";
      c.fillRect(x + 3, 0, 2, h);
    }
  });
  slatTex.wrapS = THREE.RepeatWrapping;
  slatTex.repeat.set(4, 1);
  const marbleTex = makeCanvas(256, 128, (c, w, h) => {
    c.fillStyle = "#f7f2e8";
    c.fillRect(0, 0, w, h);
    let seed = 11;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 7; i++) {
      c.strokeStyle = `rgba(150,140,125,${0.1 + rnd() * 0.12})`;
      c.lineWidth = 1 + rnd() * 1.6;
      const y0 = rnd() * h;
      c.beginPath();
      c.moveTo(0, y0);
      c.bezierCurveTo(w * 0.3, y0 + rnd() * 22 - 11, w * 0.7, y0 + rnd() * 22 - 11, w, y0 + rnd() * 14 - 7);
      c.stroke();
    }
    for (let s = 0; s < 500; s++) {
      c.fillStyle = "rgba(170,160,145,.08)";
      c.fillRect(rnd() * w, rnd() * h, 1.4, 1.4);
    }
  });
  const counter = new THREE.Group();
  const counterBody = box(7, 1.05, 1.1, std(0xffffff, { map: slatTex, roughness: 0.85 }), 0, 0.525, 0);
  counter.add(counterBody);
  counter.add(box(7.3, 0.1, 1.4, std(0xffffff, { map: marbleTex, roughness: 0.32 }), 0, 1.1, 0));
  // Brass foot rail along the counter front.
  const brassMat = std(0xc9a24a, { metalness: 0.85, roughness: 0.35 });
  const rail = cyl(0.035, 0.035, 6.6, brassMat, 0, 0.78, 0.66, 10);
  rail.rotation.z = Math.PI / 2;
  counter.add(rail);
  counter.add(box(7.3, 0.08, 1.4, trimMat, 0, 0.04, 0, false));
  // Countertop dressing: vase flowers + cups + register.
  const vaseMat = std(0x8a9a7a);
  for (const vx of [-2.6, -0.4, 2.2]) {
    counter.add(cyl(0.07, 0.1, 0.28, vaseMat, vx, 1.29, 0.1, 10));
    const bloom = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), std(0xf2e8f2));
    bloom.position.set(vx, 1.5, 0.1);
    counter.add(bloom);
  }
  for (const cx of [-1.5, 1.2]) {
    counter.add(cyl(0.09, 0.07, 0.14, std(0xfbf7ee), cx, 1.22, -0.2, 10));
  }
  // Espresso machine: steel body, two group heads, drip tray.
  const steelMat = std(0x9aa0a4, { metalness: 0.7, roughness: 0.4 });
  counter.add(box(0.58, 0.34, 0.42, steelMat, 0.7, 1.32, -0.12));
  counter.add(box(0.5, 0.05, 0.34, std(0x3a3330), 0.7, 1.17, -0.1));
  for (const gx of [0.56, 0.84]) {
    counter.add(cyl(0.045, 0.045, 0.09, steelMat, gx, 1.13, 0.02, 8));
  }
  counter.add(box(0.58, 0.06, 0.42, brassMat, 0.7, 1.52, -0.12, false));
  // Cake dome on a stand at the counter's left end.
  counter.add(cyl(0.17, 0.13, 0.06, brassMat, -2.05, 1.18, 0.12, 14));
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xdcecff, transparent: true, opacity: 0.28, roughness: 0.08 })
  );
  dome.position.set(-2.05, 1.21, 0.12);
  counter.add(dome);
  const cake = cyl(0.13, 0.13, 0.09, std(0xe8b7c2), -2.05, 1.24, 0.12, 12);
  counter.add(cake);
  counter.position.set(0, 0, -4.1);
  room.add(counter);

  // Menu boards on the back wall above the counter.
  const menuTex = makeCanvas(256, 320, (c, w, h) => {
    c.fillStyle = "#f5ecdc";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#8a5a34";
    c.font = "700 26px Georgia, serif";
    c.textAlign = "center";
    c.fillText("MENU", w / 2, 44);
    c.strokeStyle = "#b08d5f";
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(40, 60); c.lineTo(w - 40, 60); c.stroke();
    c.fillStyle = "rgba(90,60,35,.55)";
    for (let y = 92; y < h - 30; y += 26) {
      const lw = w * (0.5 + ((y * 7) % 30) / 100);
      c.fillRect((w - lw) / 2, y, lw, 5);
    }
  });
  for (const mx of [-1.5, 0, 1.5]) {
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.6), std(0xffffff, { map: menuTex }));
    board.position.set(mx, 2.9, -HZ + 0.06);
    room.add(board);
    room.add(box(1.37, 1.72, 0.05, trimMat, mx, 2.9, -HZ + 0.03, false));
  }
  // Shelves with jars flanking the menus.
  const jarMats = [std(0xd9c9a8), std(0xb08d5f), std(0x9ab08a)];
  for (const sx of [-3.4, 3.4]) {
    for (let s = 0; s < 3; s++) {
      const sy = 2.1 + s * 0.65;
      room.add(box(1.5, 0.07, 0.4, trimMat, sx, sy, -HZ + 0.25));
      for (let j = 0; j < 4; j++) {
        room.add(cyl(0.09, 0.09, 0.24, jarMats[(j + s) % 3], sx - 0.55 + j * 0.37, sy + 0.16, -HZ + 0.25, 8));
      }
    }
  }
  // Pastry display case on the counter's right end.
  const caseGlass = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.5, 0.7),
    new THREE.MeshStandardMaterial({ color: 0xdcecff, transparent: true, opacity: 0.3, roughness: 0.1 })
  );
  caseGlass.position.set(4.6, 1.45, -4.1);
  room.add(caseGlass);
  room.add(box(1.15, 0.08, 0.75, trimMat, 4.6, 1.19, -4.1));
  const pastryMat = std(0xd9a05e);
  for (let i = 0; i < 6; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), pastryMat);
    p.scale.y = 0.55;
    p.position.set(4.3 + (i % 3) * 0.3, 1.32, -4.25 + Math.floor(i / 3) * 0.28);
    room.add(p);
  }
  room.add(box(1.1, 1.1, 0.7, std(0xb0764e), 4.6, 0.55, -4.1));

  // Dining furniture: round tables, chairs, banquettes, place settings.
  const woodTex = makeCanvas(256, 256, (c, w, h) => {
    c.fillStyle = "#c9a06b";
    c.fillRect(0, 0, w, h);
    let seed = 23;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 34; i++) {
      const y0 = rnd() * h;
      c.strokeStyle = `rgba(120,84,44,${0.08 + rnd() * 0.14})`;
      c.lineWidth = 0.8 + rnd() * 2;
      c.beginPath();
      c.moveTo(0, y0);
      c.bezierCurveTo(w * 0.3, y0 + rnd() * 7 - 3.5, w * 0.7, y0 + rnd() * 7 - 3.5, w, y0 + rnd() * 5 - 2.5);
      c.stroke();
    }
    for (let i = 0; i < 5; i++) {
      const x = rnd() * w, y = rnd() * h;
      c.strokeStyle = "rgba(110,76,40,.25)";
      c.lineWidth = 1.2;
      c.beginPath(); c.arc(x, y, 3 + rnd() * 5, 0, 7); c.stroke();
    }
  });
  woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
  const tableTopMat = std(0xffffff, { map: woodTex, roughness: 0.62 });
  const chairMat = std(0xb98f5e, { roughness: 0.8, side: THREE.DoubleSide });
  const cushionMat = std(0xe8a37f, { roughness: 1 });
  const plateMat = std(0xfbf7ee, { roughness: 0.28 });
  const tableGeoTop = new THREE.CylinderGeometry(0.85, 0.85, 0.09, 22);
  const tableGeoLeg = new THREE.CylinderGeometry(0.09, 0.13, 0.72, 10);
  const plateGeo = new THREE.CylinderGeometry(0.16, 0.13, 0.035, 14);
  const cupGeo = new THREE.CylinderGeometry(0.05, 0.04, 0.09, 8);
  const matGeo = new THREE.CylinderGeometry(0.23, 0.23, 0.014, 14);
  const placematMat = std(0xb59a72, { roughness: 1 });
  const napkinMat = std(0xffffff, { roughness: 0.9 });
  // Curved rattan shell for chair backs (open half-cylinder).
  const chairBackGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.58, 12, 1, true, Math.PI / 2, Math.PI);

  function chair(x, z, yaw) {
    const g = new THREE.Group();
    g.add(box(0.5, 0.07, 0.5, chairMat, 0, 0.46, 0));
    g.add(box(0.44, 0.08, 0.44, cushionMat, 0, 0.53, 0));
    const back = new THREE.Mesh(chairBackGeo, chairMat);
    back.position.set(0, 0.86, 0.06);
    back.castShadow = true;
    g.add(back);
    for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) {
      g.add(cyl(0.03, 0.03, 0.46, chairMat, lx, 0.23, lz, 6));
    }
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    return g;
  }

  function roundTable(x, z, seats = 4, yawOff = 0) {
    const g = new THREE.Group();
    const top = new THREE.Mesh(tableGeoTop, tableTopMat);
    top.position.y = 0.76;
    top.castShadow = top.receiveShadow = true;
    g.add(top);
    const leg = new THREE.Mesh(tableGeoLeg, chairMat);
    leg.position.y = 0.38;
    leg.castShadow = true;
    g.add(leg);
    for (let i = 0; i < seats; i++) {
      const a = yawOff + (i / seats) * Math.PI * 2;
      const px = Math.cos(a) * 0.55, pz = Math.sin(a) * 0.55;
      const pmat = new THREE.Mesh(matGeo, placematMat);
      pmat.position.set(px, 0.812, pz);
      g.add(pmat);
      const plate = new THREE.Mesh(plateGeo, plateMat);
      plate.position.set(px, 0.83, pz);
      g.add(plate);
      const napkin = box(0.13, 0.016, 0.09, napkinMat, px, 0.856, pz, false);
      napkin.rotation.y = a * 1.7;
      g.add(napkin);
      const cup = new THREE.Mesh(cupGeo, plateMat);
      cup.position.set(px * 1.25, 0.86, pz * 1.25);
      g.add(cup);
      const ch = chair(0, 0, -a - Math.PI / 2);
      ch.position.set(Math.cos(a) * 1.25, 0, Math.sin(a) * 1.25);
      g.add(ch);
    }
    // Centerpiece: tiny pot + bloom.
    g.add(cyl(0.08, 0.1, 0.14, vaseMat, 0, 0.88, 0, 8));
    const bloom = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), std(0xe8b7c2));
    bloom.position.y = 1.02;
    g.add(bloom);
    g.position.set(x, 0, z);
    return g;
  }

  // Round tables dot the open floor; banquettes line the right wall.
  room.add(roundTable(-5.6, -1.6, 4, 0.4));
  room.add(roundTable(5.6, -1.6, 4, 0.1));
  room.add(roundTable(-5.4, 3.4, 4, 0.7));
  room.add(roundTable(5.4, 3.4, 4, 0.3));

  function banquette(x, z, w, rotY = 0) {
    const g = new THREE.Group();
    const baseMat = std(0xb0764e, { roughness: 0.85 });
    g.add(box(w, 0.5, 0.7, baseMat, 0, 0.25, 0));
    g.add(box(w, 0.18, 0.75, cushionMat, 0, 0.58, 0));
    g.add(box(w, 0.9, 0.22, baseMat, 0, 0.9, -0.32));
    g.add(box(w - 0.2, 0.55, 0.14, cushionMat, 0, 0.95, -0.2));
    // Small tables + chairs facing the bench.
    const n = Math.max(1, Math.round(w / 2.2));
    for (let i = 0; i < n; i++) {
      const tx = n === 1 ? 0 : -w / 2 + 1.1 + (i * (w - 2.2)) / (n - 1);
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.8), tableTopMat);
      top.position.set(tx, 0.74, 1.05);
      top.castShadow = true;
      g.add(top);
      g.add(box(0.12, 0.7, 0.12, chairMat, tx, 0.37, 1.05));
      const pmat2 = new THREE.Mesh(matGeo, placematMat);
      pmat2.position.set(tx, 0.79, 1.0);
      g.add(pmat2);
      const plate = new THREE.Mesh(plateGeo, plateMat);
      plate.position.set(tx, 0.8, 1.0);
      g.add(plate);
      g.add(chair(tx, 1.85, Math.PI));
    }
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    return g;
  }
  room.add(banquette(8.6, -1.2, 4.4, -Math.PI / 2));
  room.add(banquette(8.6, 3.6, 4.0, -Math.PI / 2));
  room.add(banquette(-6.4, -4.9, 4.2, 0));

  // Long communal table on the left.
  function communalTable(x, z) {
    const g = new THREE.Group();
    const top = box(1.3, 0.09, 4.6, tableTopMat, 0, 0.76, 0);
    g.add(top);
    for (const [lx, lz] of [[-0.5, -2], [0.5, -2], [-0.5, 2], [0.5, 2]]) {
      g.add(box(0.12, 0.72, 0.12, chairMat, lx, 0.36, lz));
    }
    for (let i = 0; i < 4; i++) {
      const pz = -1.7 + i * 1.13;
      for (const side of [-1, 1]) {
        const pmat3 = new THREE.Mesh(matGeo, placematMat);
        pmat3.position.set(side * 0.35, 0.812, pz);
        g.add(pmat3);
        const plate = new THREE.Mesh(plateGeo, plateMat);
        plate.position.set(side * 0.35, 0.83, pz);
        g.add(plate);
        g.add(chair(side * 1.05, pz, side > 0 ? -Math.PI / 2 : Math.PI / 2));
      }
    }
    g.add(cyl(0.08, 0.1, 0.16, vaseMat, 0, 0.89, 0, 8));
    g.position.set(x, 0, z);
    return g;
  }
  room.add(communalTable(-8.2, 0.6));

  // Central olive tree in its planter, ringed by coral benches.
  const tree = new THREE.Group();
  const planterMat = std(0xb0764e, { roughness: 0.85 });
  tree.add(box(1.7, 0.55, 1.7, planterMat, 0, 0.275, 0));
  tree.add(box(1.5, 0.2, 1.5, cushionMat, 0, 0.62, 0));
  // Bench seats hugging all four sides of the planter.
  for (const [bx, bz, rot] of [[0, -1.04, 0], [0, 1.04, 0], [-1.04, 0, Math.PI / 2], [1.04, 0, Math.PI / 2]]) {
    const bench = new THREE.Group();
    bench.add(box(1.7, 0.34, 0.38, planterMat, 0, 0.17, 0));
    bench.add(box(1.66, 0.14, 0.42, cushionMat, 0, 0.41, 0));
    bench.position.set(bx, 0, bz);
    bench.rotation.y = rot;
    tree.add(bench);
  }
  const trunkMat = std(0x7a5a3a, { roughness: 1 });
  const trunk = cyl(0.14, 0.21, 1.6, trunkMat, 0, 1.4, 0, 10);
  trunk.rotation.z = 0.06;
  tree.add(trunk);
  const branch = cyl(0.06, 0.1, 1.1, trunkMat, 0.42, 2.15, 0.15, 8);
  branch.rotation.z = -0.7;
  tree.add(branch);
  const crownMats = [std(0x5e8a5a), std(0x6fa06a), std(0x527a4e), std(0x7fae72)];
  const crownGeo = new THREE.IcosahedronGeometry(0.75, 1);
  const crownSpots = [
    [0, 2.95, 0, 1.2], [0.8, 2.45, 0.3, 0.85], [-0.75, 2.55, -0.25, 0.9],
    [0.1, 2.35, -0.75, 0.75], [-0.2, 2.45, 0.8, 0.8], [0.55, 2.8, -0.55, 0.7],
    [-0.5, 2.85, 0.55, 0.72], [0.05, 3.3, 0.1, 0.8],
  ];
  crownSpots.forEach(([cx, cy, cz, s], i) => {
    const blob = new THREE.Mesh(crownGeo, crownMats[i % 4]);
    blob.position.set(cx, cy, cz);
    blob.scale.set(s, s * 0.82, s);
    blob.rotation.set(i * 1.3, i * 2.1, i * 0.7);
    blob.castShadow = true;
    tree.add(blob);
  });
  // Tiny olives tucked under the crown.
  const oliveMat = std(0x3a4030, { roughness: 0.5 });
  const oliveGeo = new THREE.SphereGeometry(0.05, 8, 8);
  [[0.6, 2.2, 0.5], [-0.55, 2.3, 0.35], [0.2, 2.1, -0.6], [-0.3, 2.15, -0.5],
   [0.75, 2.5, -0.2], [-0.8, 2.4, -0.05], [0.35, 2.25, 0.75], [-0.15, 2.05, 0.6],
   [0.5, 2.6, 0.65], [-0.65, 2.7, 0.45], [0.9, 2.3, 0.15], [-0.45, 2.5, -0.65],
  ].forEach(([ox, oy, oz]) => {
    const olive = new THREE.Mesh(oliveGeo, oliveMat);
    olive.position.set(ox, oy, oz);
    tree.add(olive);
  });
  tree.position.set(0, 0, 0.4);
  room.add(tree);

  // Potted palms in the corners.
  function pottedPalm(x, z, s = 1) {
    const g = new THREE.Group();
    g.add(cyl(0.32 * s, 0.24 * s, 0.55 * s, std(0xb4653f), 0, 0.27 * s, 0, 12));
    g.add(cyl(0.28 * s, 0.28 * s, 0.1 * s, std(0x4a3423), 0, 0.55 * s, 0, 12));
    g.add(cyl(0.05 * s, 0.07 * s, 0.9 * s, std(0x7a5a3a), 0, 1.0 * s, 0, 8));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const frond = new THREE.Mesh(new THREE.SphereGeometry(0.42 * s, 8, 6), crownMats[i % 3]);
      frond.scale.set(1.4, 0.45, 0.7);
      frond.position.set(Math.cos(a) * 0.45 * s, 1.5 * s, Math.sin(a) * 0.45 * s);
      frond.rotation.y = -a;
      frond.castShadow = true;
      g.add(frond);
    }
    g.position.set(x, 0, z);
    return g;
  }
  room.add(pottedPalm(-9.0, -5.2, 1.15));
  room.add(pottedPalm(9.0, -5.0, 1.0));
  room.add(pottedPalm(-9.0, 5.2, 0.9));
  room.add(pottedPalm(9.0, 5.3, 1.1));
  room.add(pottedPalm(-1.6, 5.6, 0.7));
  room.add(pottedPalm(1.6, 5.6, 0.75));



  // Little Muse avatars: capsule body in the agent color, cream head with
  // a face, tiny cap, waddling feet, swinging arms. Geometries shared;
  // body materials cached per color.
  const avGeos = {
    body: new THREE.CapsuleGeometry(0.3, 0.42, 6, 14),
    head: new THREE.SphereGeometry(0.34, 20, 16),
    eye: new THREE.SphereGeometry(0.055, 10, 10),
    cheek: new THREE.SphereGeometry(0.05, 8, 8),
    smile: new THREE.TorusGeometry(0.09, 0.018, 8, 14, Math.PI * 0.8),
    cap: new THREE.CylinderGeometry(0.17, 0.19, 0.09, 14),
    pom: new THREE.SphereGeometry(0.06, 8, 8),
    arm: new THREE.CapsuleGeometry(0.085, 0.24, 4, 8),
    foot: new THREE.SphereGeometry(0.13, 10, 8),
  };
  const avMats = {
    head: std(0xfff7ec, { roughness: 0.6 }),
    eye: std(0x2b2118, { roughness: 0.3 }),
    cheek: std(0xf0a8a0, { roughness: 0.8 }),
    smile: std(0x7a5a48, { roughness: 0.7 }),
    foot: std(0x5a4a3e, { roughness: 0.8 }),
  };
  const bodyMatCache = new Map();
  function bodyMat(color) {
    const key = color || "#a78bfa";
    let m = bodyMatCache.get(key);
    if (!m) {
      m = std(new THREE.Color(key), { roughness: 0.65 });
      bodyMatCache.set(key, m);
    }
    return m;
  }

  const avatars = new Map(); // key -> {group, parts, target, yaw, phase, label...}
  const avatarPickMeshes = [];

  function buildAvatar(agent) {
    const g = new THREE.Group();
    const bm = bodyMat(agent.color);
    const body = new THREE.Mesh(avGeos.body, bm);
    body.position.y = 0.62;
    body.castShadow = true;
    g.add(body);
    const headG = new THREE.Group();
    headG.position.y = 1.32;
    const head = new THREE.Mesh(avGeos.head, avMats.head);
    head.castShadow = true;
    headG.add(head);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(avGeos.eye, avMats.eye);
      eye.position.set(side * 0.13, 0.06, 0.29);
      headG.add(eye);
      const cheek = new THREE.Mesh(avGeos.cheek, avMats.cheek);
      cheek.scale.z = 0.4;
      cheek.position.set(side * 0.22, -0.08, 0.25);
      headG.add(cheek);
    }
    const smile = new THREE.Mesh(avGeos.smile, avMats.smile);
    smile.position.set(0, -0.04, 0.3);
    smile.rotation.z = Math.PI * 1.1;
    headG.add(smile);
    const cap = new THREE.Mesh(avGeos.cap, bm);
    cap.position.set(0.05, 0.33, -0.02);
    cap.rotation.z = -0.18;
    headG.add(cap);
    const pom = new THREE.Mesh(avGeos.pom, avMats.head);
    pom.position.set(0.05, 0.42, -0.02);
    headG.add(pom);
    g.add(headG);
    // Arms on shoulder pivots so they can swing.
    const arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.34, 0.82, 0);
      const arm = new THREE.Mesh(avGeos.arm, bm);
      arm.position.y = -0.18;
      arm.castShadow = true;
      pivot.add(arm);
      g.add(pivot);
      arms.push(pivot);
    }
    const feet = [];
    for (const side of [-1, 1]) {
      const foot = new THREE.Mesh(avGeos.foot, avMats.foot);
      foot.scale.set(1, 0.6, 1.3);
      foot.position.set(side * 0.15, 0.09, 0);
      foot.castShadow = true;
      g.add(foot);
      feet.push(foot);
    }
    // Talking pulse ring under the feet.
    const pulse = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.5, 28),
      new THREE.MeshBasicMaterial({ color: 0x5c7a4e, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 0.02;
    g.add(pulse);
    g.traverse((o) => {
      if (o.isMesh && o !== pulse) avatarPickMeshes.push(o);
    });
    return { group: g, headG, arms, feet, pulse, body, cap };
  }

  function agentKey(a) {
    return a.id || a.name;
  }

  function setAgents(list) {
    const seen = new Set();
    for (const a of list || []) {
      const key = agentKey(a);
      if (!key) continue;
      seen.add(key);
      let av = avatars.get(key);
      const w = serverToWorld(a.x || 500, a.y || 310);
      if (!av) {
        const parts = buildAvatar(a);
        parts.group.position.set(w.x, 0, w.z);
        parts.group.traverse((o) => {
          o.userData.avatarKey = key;
        });
        scene.add(parts.group);
        const pill = document.createElement("div");
        pill.className = "p3d-pill";
        const check = document.createElement("span");
        check.className = "p3d-check";
        check.textContent = "✓ ";
        const nm = document.createElement("span");
        nm.className = "p3d-name";
        const dots = document.createElement("span");
        dots.className = "p3d-dots";
        pill.append(check, nm, dots);
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          onAgentClick(a.name);
        });
        const bub = document.createElement("div");
        bub.className = "p3d-bub";
        labelsEl.append(pill, bub);
        av = {
          ...parts, key, pill, nm, dots, check, bub,
          target: new THREE.Vector3(w.x, 0, w.z),
          yaw: Math.PI, phase: Math.random() * 6,
          talking: false, bubble: null, convo: null, name: "",
          lastDots: -1,
        };
        avatars.set(key, av);
      }
      av.target.set(w.x, 0, w.z);
      av.talking = !!a.talking;
      av.bubble = a.bubble || null;
      av.convo = a.convo || null;
      av.name = a.name || "";
      av.verified = a.verified === "verified";
      // Body color follows the agent (cheap: shared cached materials).
      const bm = bodyMat(a.color);
      av.body.material = bm;
      av.cap.material = bm;
      av.arms.forEach((p) => {
        p.children[0].material = bm;
      });
    }
    for (const [key, av] of avatars) {
      if (!seen.has(key)) {
        scene.remove(av.group);
        av.group.traverse((o) => {
          const i = avatarPickMeshes.indexOf(o);
          if (i >= 0) avatarPickMeshes.splice(i, 1);
        });
        av.pill.remove();
        av.bub.remove();
        avatars.delete(key);
      }
    }
  }

  // Conversation perimeters: one soft ring per convo group.
  const convoRings = new Map();
  const convoMat = new THREE.MeshBasicMaterial({
    color: 0xc2704e, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
  });
  function updateConvoRings() {
    const groups = new Map();
    for (const av of avatars.values()) {
      if (!av.convo) continue;
      let g = groups.get(av.convo);
      if (!g) {
        g = [];
        groups.set(av.convo, g);
      }
      g.push(av);
    }
    for (const [id, ring] of convoRings) {
      if (!groups.has(id)) {
        scene.remove(ring);
        ring.geometry.dispose();
        convoRings.delete(id);
      }
    }
    for (const [id, members] of groups) {
      if (members.length < 2) continue;
      let cx = 0, cz = 0;
      for (const m of members) {
        cx += m.group.position.x;
        cz += m.group.position.z;
      }
      cx /= members.length;
      cz /= members.length;
      let r = 0;
      for (const m of members) {
        r = Math.max(r, Math.hypot(m.group.position.x - cx, m.group.position.z - cz));
      }
      r += 0.9;
      let ring = convoRings.get(id);
      if (!ring) {
        ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 40), convoMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.03;
        scene.add(ring);
        convoRings.set(id, ring);
      }
      ring.position.x = cx;
      ring.position.z = cz;
      ring.scale.set(r, r, 1);
    }
  }

  // Labels: HTML name pills + speech bubbles projected each frame.
  const projV = new THREE.Vector3();
  function updateLabels() {
    const w = container.clientWidth, h = container.clientHeight;
    for (const av of avatars.values()) {
      if (av.nm.textContent !== av.name) av.nm.textContent = av.name;
      av.check.style.display = av.verified ? "" : "none";
      av.pill.classList.toggle("talking", av.talking);
      const n = av.talking ? 1 + ((performance.now() / 400) | 0) % 3 : 0;
      if (n !== av.lastDots) {
        av.lastDots = n;
        av.dots.textContent = n ? " " + "●".repeat(n) : "";
      }
      if (av.bubble) {
        if (av.bub.textContent !== av.bubble) av.bub.textContent = av.bubble;
        av.bub.style.display = "";
      } else {
        av.bub.style.display = "none";
      }
      projV.set(av.group.position.x, 1.95, av.group.position.z).project(camera);
      const behind = projV.z > 1;
      const sx = (projV.x * 0.5 + 0.5) * w;
      const sy = (-projV.y * 0.5 + 0.5) * h;
      const off = behind || sx < -80 || sx > w + 80 || sy < -60 || sy > h + 60;
      av.pill.style.display = off ? "none" : "";
      if (av.bubble) av.bub.style.display = off ? "none" : "";
      if (off) continue;
      av.pill.style.transform = `translate(-50%,-100%) translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px)`;
      // The bubble sits above the pill; the pill height is stable, so
      // measure it once instead of forcing layout every frame.
      if (!av.pillH) av.pillH = av.pill.offsetHeight || 24;
      const gap = av.pillH + 8;
      av.bub.style.transform = `translate(-50%,-100%) translate(${sx.toFixed(1)}px,${(sy - gap).toFixed(1)}px)`;
    }
  }

  // Picking: avatars. Click vs drag by movement threshold.
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  function pickAt(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    pointerNdc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const avHits = raycaster.intersectObjects(avatarPickMeshes, false);
    if (avHits.length) {
      const key = avHits[0].object.userData.avatarKey;
      const av = avatars.get(key);
      if (av) return { name: av.name };
    }
    return null;
  }

  // Camera controls: wheel zoom to cursor, drag pan, fit. Fixed angle.
  const ZMAX = 3, ZMIN_ABS = 0.35;
  let zMinLive = 1;
  function clampCam() {
    camZoom = Math.min(ZMAX, Math.max(zMinLive, camZoom));
    if (camZoom <= zMinLive * 1.001) {
      camTarget.set(0, 0, -0.2);
      updateCamera();
      return;
    }
    camTarget.x = Math.max(-8, Math.min(8, camTarget.x));
    camTarget.z = Math.max(-6, Math.min(6, camTarget.z));
    camTarget.y = 0;
    updateCamera();
  }
  function fit() {
    zMinLive = Math.max(ZMIN_ABS, Math.min(ZMAX, fitZoom()));
    camZoom = zMinLive;
    camTarget.set(0, 0, -0.2);
    updateCamera();
  }
  renderer.domElement.addEventListener("wheel", (e) => {
    e.preventDefault();
    camZoom = Math.min(ZMAX, Math.max(zMinLive, camZoom * Math.exp(-e.deltaY * 0.0015)));
    clampCam();
  }, { passive: false });
  let drag = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, tx: camTarget.x, tz: camTarget.z, moved: false };
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!drag) {
      renderer.domElement.style.cursor = pickAt(e.clientX, e.clientY) ? "pointer" : "";
      return;
    }
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = true;
    // Screen drag -> ground-plane pan, scaled by the ortho frustum.
    const frustumW = (camera.right - camera.left) / camZoom;
    const frustumH = (camera.top - camera.bottom) / camZoom;
    const r = renderer.domElement.getBoundingClientRect();
    camTarget.x = drag.tx - ((e.clientX - drag.x) / r.width) * frustumW;
    // Camera looks down at an angle: vertical drag moves mostly along z.
    camTarget.z = drag.tz - ((e.clientY - drag.y) / r.height) * frustumH * 0.75;
    clampCam();
  });
  function endDrag(e) {
    if (drag && !drag.moved && e && e.type === "pointerup") {
      const hit = pickAt(e.clientX, e.clientY);
      if (hit) onAgentClick(hit.name);
    }
    drag = null;
  }
  renderer.domElement.addEventListener("pointerup", endDrag);
  renderer.domElement.addEventListener("pointercancel", endDrag);

  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    zMinLive = Math.max(ZMIN_ABS, Math.min(ZMAX, fitZoom()));
    clampCam();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  // Per-frame avatar motion: ease toward server targets, face travel
  // direction, waddle while moving, idle bob otherwise.
  function updateAvatars(dt) {
    const k = 1 - Math.exp(-dt * 5);
    for (const av of avatars.values()) {
      const p = av.group.position;
      const dx = av.target.x - p.x, dz = av.target.z - p.z;
      const dist = Math.hypot(dx, dz);
      p.x += dx * k;
      p.z += dz * k;
      const moving = dist > 0.02;
      if (moving) {
        const targetYaw = Math.atan2(dx, dz);
        let d = targetYaw - av.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        av.yaw += d * (1 - Math.exp(-dt * 8));
        av.group.rotation.y = av.yaw;
      }
      if (REDUCED_MOTION) {
        av.group.position.y = 0;
        continue;
      }
      av.phase += dt * (moving ? 11 : 2.2);
      const s = Math.sin(av.phase);
      if (moving) {
        av.feet[0].position.z = s * 0.14;
        av.feet[1].position.z = -s * 0.14;
        av.arms[0].rotation.x = -s * 0.7;
        av.arms[1].rotation.x = s * 0.7;
        av.group.position.y = Math.abs(Math.cos(av.phase)) * 0.06;
        av.group.rotation.z = s * 0.05;
        av.headG.rotation.y = 0;
      } else {
        av.feet[0].position.z = 0;
        av.feet[1].position.z = 0;
        av.arms[0].rotation.x *= 0.9;
        av.arms[1].rotation.x *= 0.9;
        av.group.position.y = Math.sin(av.phase) * 0.03 + 0.03;
        av.group.rotation.z *= 0.9;
        // Idle: glance around slowly.
        av.headG.rotation.y = Math.sin(av.phase * 0.35) * 0.4;
      }
      // Talking pulse ring.
      if (av.talking) {
        const pr = (performance.now() / 1100 + p.x * 0.13) % 1;
        av.pulse.material.opacity = (1 - pr) * 0.55;
        const rs = 1 + pr * 0.9;
        av.pulse.scale.set(rs, rs, 1);
        av.headG.position.y = 1.32 + Math.abs(Math.sin(av.phase * 1.6)) * 0.03;
      } else {
        av.pulse.material.opacity = 0;
      }
    }
  }

  // Main loop. Runs only while the view is visible.
  const clock = new THREE.Clock();
  let visible = true;
  let rafId = 0;
  function frame() {
    rafId = 0;
    if (!visible) return;
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    updateAvatars(dt);
    updateConvoRings();
    if (!REDUCED_MOTION) {
      const fl = 0.9 + 0.06 * Math.sin(t * 2.1) + 0.04 * Math.sin(t * 5.7);
      for (const pl of tableLights) pl.intensity = 12 * fl;
    }
    updateLabels();
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  }
  function setVisible(v) {
    if (v === visible) return;
    visible = v;
    if (v) {
      clock.getDelta();
      resize();
      if (!rafId) rafId = requestAnimationFrame(frame);
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }
  function dispose() {
    setVisible(false);
    resizeObserver.disconnect();
    renderer.dispose();
    container.innerHTML = "";
    avatars.clear();
  }

  resize();
  fit();
  applyTheme(themeName);
  rafId = requestAnimationFrame(frame);

  return {
    setAgents,
    setTheme: (name) => applyTheme(name),
    setVisible,
    resize,
    dispose,
    zoomIn: () => {
      camZoom = Math.min(ZMAX, camZoom * 1.25);
      clampCam();
    },
    zoomOut: () => {
      camZoom = Math.max(zMinLive, camZoom / 1.25);
      clampCam();
    },
    fit,
    get agentCount() {
      return avatars.size;
    },
  };
}
