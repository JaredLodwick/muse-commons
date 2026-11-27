// lobby3d.js - isometric 3D hotel lobby view (Lobby v1, 2026-11-04).
// The hotel's front room: Classic Grand dress (marble, brass, dark
// walnut) on a Garden Atrium arrangement - seven venue portals set into
// the walls around one central check-in desk, all on one level. The
// portal/desk positions come from the server world definition
// (/api/places -> room "lobby" -> layout), so this view and the in-app
// artifact render the same lobby from one source; FALLBACK_LAYOUT below
// only covers a layout that failed to arrive. Lighting runs on Commons
// time through plaza3d's plazaTimeOfDay: day, twilight, and after dark
// the Evening Jazz state (low ambient, warm sconce pools turned up).
import * as THREE from "./three.module.min.js";
import { plazaTimeOfDay, serverToWorld } from "./plaza3d.js";

const PX = 1 / 50; // server px -> world units
const ROOM_W = 1000 * PX; // 20
const ROOM_H = 620 * PX; // 12.4
const HX = ROOM_W / 2; // 10
const HZ = ROOM_H / 2; // 6.2
const WALL_H = 4.6;
const WALL_T = 0.6;

const REDUCED_MOTION = (() => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
})();

// Mirror of the server LOBBY_LAYOUT (server/lobby.js), used only when
// the live layout is missing from /api/places.
const FALLBACK_LAYOUT = {
  floor: { w: 1000, h: 620 },
  desk: { x: 500, y: 320, w: 180, h: 76, label: "Check-in" },
  entrance: { x: 500, y: 545 },
  portals: [
    { id: "restaurant-one", name: "Restaurant One", x: 180, y: 46, w: 150, h: 92, wall: "back", target: null, state: "locked", blurb: "" },
    { id: "cafe", name: "The Cafe", x: 500, y: 46, w: 170, h: 92, wall: "back", target: "plaza", state: "open", blurb: "" },
    { id: "restaurant-two", name: "Restaurant Two", x: 820, y: 46, w: 150, h: 92, wall: "back", target: null, state: "locked", blurb: "" },
    { id: "pool-deck", name: "Pool Deck", x: 46, y: 180, w: 92, h: 150, wall: "left", target: null, state: "locked", blurb: "" },
    { id: "nightclub", name: "Nightclub", x: 46, y: 440, w: 92, h: 150, wall: "left", target: null, state: "locked", blurb: "" },
    { id: "garden-terrace", name: "Garden Terrace", x: 954, y: 180, w: 92, h: 150, wall: "right", target: null, state: "locked", blurb: "" },
    { id: "gym", name: "Gym", x: 954, y: 440, w: 92, h: 150, wall: "right", target: null, state: "locked", blurb: "" },
  ],
};

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

// Classic Grand palette: cream marble, brass, walnut, a deep burgundy
// rug. Material colors never change; light and dark come from the time
// of day alone (the UI theme switcher restyles page chrome only).
const PALETTE = {
  bg: 0xe9dcc4,
  wall: 0xf0e6d0, trim: 0xa8823f, brass: 0xc9a227,
  walnut: 0x4a3220, walnutDark: 0x38240f,
  marble: 0xf4efe4, marbleDark: 0x3d4a42,
  rug: 0x7a3038, doorIn: 0x2e2013,
};

const COMMONS_TZ = "America/Los_Angeles";
const COMMONS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: COMMONS_TZ, hourCycle: "h23",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export function createLobbyView(container, opts = {}) {
  const layout = opts.layout || FALLBACK_LAYOUT;
  const onAgentClick = opts.onAgentClick || (() => {});
  const onPortal = opts.onPortal || (() => {});
  const onDesk = opts.onDesk || (() => {});
  const onFloor = opts.onFloor || (() => {});

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.className = "p3d-canvas";
  container.appendChild(renderer.domElement);

  const labelsEl = document.createElement("div");
  labelsEl.className = "p3d-labels";
  container.appendChild(labelsEl);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.bg);

  // Same dollhouse camera as the cafe view: mild perspective lens from
  // the front, raised, so the side walls read in perspective.
  const FOV = 32;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 220);
  const camOffset = new THREE.Vector3(3.4, 20, 14).normalize();
  let camDist = 36;
  const camTarget = new THREE.Vector3(0, 0, -0.2);
  let camZoom = 1;
  // Tap-to-focus: a goal the camera eases toward (null = free camera).
  let focusGoal = null;
  function updateCamera() {
    camera.position.copy(camTarget).addScaledVector(camOffset, camDist / camZoom);
    camera.lookAt(camTarget);
    camera.updateProjectionMatrix();
  }
  function fitDistance() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const aspect = w / h;
    camera.aspect = aspect;
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const tanH = tanV * aspect;
    return Math.max(23.5 / 2 / tanH, 16.5 / 2 / tanV) * 1.03;
  }

  // Lights: hemisphere + ambient fill, the sun/moon directional, and
  // warm sconce pools along the walls (invisible sources, no hanging
  // fixtures) that burn brighter after dark - the Evening Jazz state.
  const hemi = new THREE.HemisphereLight(0xfff4e0, 0xb08d5f, 0.85);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xfff2e0, 0.35);
  scene.add(amb);
  const sun = new THREE.DirectionalLight(0xffe7c4, 1.6);
  sun.position.set(-12, 16, 9);
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
  const sconces = [];
  for (const [lx, lz] of [[-7.5, -5.4], [0, -5.4], [7.5, -5.4], [-9.3, 0], [9.3, 0], [0, 2.2]]) {
    const pl = new THREE.PointLight(0xffc98a, 12, 13, 1.8);
    pl.position.set(lx, 3.4, lz);
    scene.add(pl);
    sconces.push(pl);
  }

  // Gentle bloom, same vendored passes as the cafe view; any failure
  // leaves plain rendering in place.
  let composer = null;
  (async () => {
    try {
      const [ec, rp, ubp, op] = await Promise.all([
        import("./addons/postprocessing/EffectComposer.js"),
        import("./addons/postprocessing/RenderPass.js"),
        import("./addons/postprocessing/UnrealBloomPass.js"),
        import("./addons/postprocessing/OutputPass.js"),
      ]);
      const c = new ec.EffectComposer(renderer);
      c.addPass(new rp.RenderPass(scene, camera));
      c.addPass(new ubp.UnrealBloomPass(
        new THREE.Vector2(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight)),
        0.38, 0.65, 0.82
      ));
      c.addPass(new op.OutputPass());
      c.setPixelRatio(renderer.getPixelRatio());
      c.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
      composer = c;
    } catch (e) {
      composer = null;
    }
  })();

  // --- Time of day ---------------------------------------------------
  let poolBase = 12;
  function commonsMinutes() {
    const parts = COMMONS_FMT.formatToParts(new Date(serverNow()));
    let hh = 0, mm = 0, ss = 0;
    for (const p of parts) {
      if (p.type === "hour") hh = Number(p.value) % 24;
      else if (p.type === "minute") mm = Number(p.value);
      else if (p.type === "second") ss = Number(p.value);
    }
    return hh * 60 + mm + ss / 60;
  }
  function applySceneTime() {
    const st = plazaTimeOfDay(commonsMinutes() / 60);
    scene.background.setHex(st.bg);
    hemi.color.setHex(st.hemiSky);
    hemi.groundColor.setHex(st.hemiGround);
    hemi.intensity = st.hemiInt;
    amb.color.setHex(st.ambColor);
    amb.intensity = st.ambInt;
    sun.position.set(st.dir.pos[0], st.dir.pos[1], st.dir.pos[2]);
    sun.color.setHex(st.dir.color);
    sun.intensity = st.dir.intensity;
    poolBase = st.poolInt;
    if (REDUCED_MOTION) {
      for (const pl of sconces) pl.intensity = poolBase;
    }
    // The open Cafe portal glows warm; at night it glows harder
    // against the dim room (Evening Jazz spilling through one door).
    cafeGlowMat.emissiveIntensity = 0.55 + 0.75 * (1 - st.dayFactor);
    sconceGlowMat.emissiveIntensity = st.sconceInt;
  }

  const room = new THREE.Group();
  scene.add(room);

  // Floor: cream-and-smoke marble checker with a brass inlay border.
  const floorTex = makeCanvas(1024, 640, (c, w, h) => {
    const tw = 128, th = 128;
    let seed = 11;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let ty = 0; ty < h / th; ty++) {
      for (let tx = 0; tx < w / tw; tx++) {
        const dark = (tx + ty) % 2 === 1;
        const v = rnd() * 10 - 5;
        c.fillStyle = dark
          ? `rgb(${61 + v},${74 + v},${66 + v})`
          : `rgb(${244 + v},${239 + v},${228 + v})`;
        c.fillRect(tx * tw + 2, ty * th + 2, tw - 4, th - 4);
        // Marble veins.
        c.strokeStyle = dark ? "rgba(220,230,220,.12)" : "rgba(140,130,110,.16)";
        c.lineWidth = 1.3;
        for (let vn = 0; vn < 2; vn++) {
          const vy = ty * th + rnd() * th;
          c.beginPath();
          c.moveTo(tx * tw, vy);
          c.bezierCurveTo(
            tx * tw + tw * 0.3, vy + rnd() * 12 - 6,
            tx * tw + tw * 0.7, vy + rnd() * 12 - 6,
            tx * tw + tw, vy + rnd() * 10 - 5
          );
          c.stroke();
        }
        for (let s = 0; s < 160; s++) {
          c.fillStyle = rnd() > 0.5 ? "rgba(120,110,90,.10)" : "rgba(255,255,250,.12)";
          c.fillRect(tx * tw + rnd() * tw, ty * th + rnd() * th, 1.6, 1.6);
        }
      }
    }
  });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(2.5, 1.6);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_H),
    std(PALETTE.marble, { map: floorTex, roughness: 0.55 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.add(floor);
  const skirt = box(ROOM_W + 3, 0.8, ROOM_H + 3, std(0x6b5636), 0, -0.42, 0, false);
  skirt.receiveShadow = true;
  room.add(skirt);
  // Brass inlay border tracing the floor edge.
  const inlayMat = std(PALETTE.brass, { roughness: 0.35, metalness: 0.65 });
  room.add(box(ROOM_W - 1.2, 0.03, 0.09, inlayMat, 0, 0.015, -HZ + 0.6, false));
  room.add(box(ROOM_W - 1.2, 0.03, 0.09, inlayMat, 0, 0.015, HZ - 0.6, false));
  room.add(box(0.09, 0.03, ROOM_H - 1.2, inlayMat, -HX + 0.6, 0.015, 0, false));
  room.add(box(0.09, 0.03, ROOM_H - 1.2, inlayMat, HX - 0.6, 0.015, 0, false));

  // Burgundy rug under the check-in desk.
  const rugTex = makeCanvas(512, 320, (c, w, h) => {
    c.fillStyle = "#7a3038";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "#c9a227";
    c.lineWidth = 8;
    c.strokeRect(14, 14, w - 28, h - 28);
    c.strokeStyle = "rgba(244,239,228,.5)";
    c.lineWidth = 3;
    c.strokeRect(34, 34, w - 68, h - 68);
    c.strokeStyle = "rgba(201,162,39,.4)";
    c.lineWidth = 2;
    const step = 44;
    for (let x = -h; x < w + h; x += step) {
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x + h, h); c.stroke();
      c.beginPath(); c.moveTo(x + h, 0); c.lineTo(x, h); c.stroke();
    }
  });
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(7.4, 4.6),
    std(PALETTE.rug, { map: rugTex, roughness: 1 })
  );
  rug.rotation.x = -Math.PI / 2;
  const deskW = serverToWorld(layout.desk.x, layout.desk.y);
  rug.position.set(deskW.x, 0.01, deskW.z + 0.4);
  rug.receiveShadow = true;
  room.add(rug);

  // Walls: warm plaster, brass cap trim, walnut baseboards. Tall back
  // and sides, low dollhouse curb at the front (the entrance side).
  const plasterTex = makeCanvas(512, 512, (c, w, h) => {
    c.fillStyle = "#f4eee0";
    c.fillRect(0, 0, w, h);
    let seed = 41;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 80; i++) {
      const x = rnd() * w, y = rnd() * h, r = 30 + rnd() * 90;
      const grad = c.createRadialGradient(x, y, 0, x, y, r);
      const tone = rnd() > 0.5 ? "216,200,168" : "255,252,244";
      grad.addColorStop(0, `rgba(${tone},.10)`);
      grad.addColorStop(1, `rgba(${tone},0)`);
      c.fillStyle = grad;
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    }
  });
  plasterTex.wrapS = plasterTex.wrapT = THREE.RepeatWrapping;
  plasterTex.repeat.set(3, 1);
  const wallMat = std(PALETTE.wall, { map: plasterTex, roughness: 0.95 });
  const trimMat = std(PALETTE.trim, { roughness: 0.4, metalness: 0.55 });
  const walnutMat = std(PALETTE.walnut, { roughness: 0.8 });
  room.add(box(ROOM_W + 2 * WALL_T, WALL_H, WALL_T, wallMat, 0, WALL_H / 2, -HZ - WALL_T / 2));
  room.add(box(WALL_T, WALL_H, ROOM_H, wallMat, -HX - WALL_T / 2, WALL_H / 2, 0));
  room.add(box(WALL_T, WALL_H, ROOM_H, wallMat, HX + WALL_T / 2, WALL_H / 2, 0));
  room.add(box(ROOM_W + 2 * WALL_T, 0.9, WALL_T, wallMat, 0, 0.45, HZ + WALL_T / 2));
  room.add(box(ROOM_W + 2 * WALL_T, 0.18, WALL_T + 0.15, trimMat, 0, WALL_H + 0.09, -HZ - WALL_T / 2));
  room.add(box(WALL_T + 0.15, 0.18, ROOM_H, trimMat, -HX - WALL_T / 2, WALL_H + 0.09, 0));
  room.add(box(WALL_T + 0.15, 0.18, ROOM_H, trimMat, HX + WALL_T / 2, WALL_H + 0.09, 0));
  room.add(box(ROOM_W, 0.26, 0.1, walnutMat, 0, 0.13, -HZ + 0.05, false));
  room.add(box(0.1, 0.26, ROOM_H, walnutMat, -HX + 0.05, 0.13, 0, false));
  room.add(box(0.1, 0.26, ROOM_H, walnutMat, HX - 0.05, 0.13, 0, false));

  // Sconce glows on the back wall (emissive discs - the light itself
  // comes from the point lights above; no hanging fixtures).
  const sconceGlowMat = new THREE.MeshStandardMaterial({
    color: 0xffd9a0, emissive: 0xffb35c, emissiveIntensity: 1.2, roughness: 0.6,
  });
  for (const sx of [-7.5, 0, 7.5]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), sconceGlowMat);
    s.position.set(sx, 3.4, -HZ + 0.12);
    room.add(s);
  }

  // --- Portals --------------------------------------------------------
  // Arched doorways built straight from the layout. A locked venue is a
  // pair of walnut doors with a brass nameplate; the one open portal
  // (the Cafe) has no doors - warm light and a floor pool instead.
  const cafeGlowMat = new THREE.MeshStandardMaterial({
    color: 0xffd9a3, emissive: 0xffa64d, emissiveIntensity: 0.8, roughness: 0.7,
  });
  const portalPickMeshes = [];
  const portalById = new Map();
  function plaqueTexture(text) {
    return makeCanvas(512, 112, (c, w, h) => {
      c.fillStyle = "#2e2013";
      c.fillRect(0, 0, w, h);
      c.strokeStyle = "#c9a227";
      c.lineWidth = 5;
      c.strokeRect(7, 7, w - 14, h - 14);
      c.fillStyle = "#f0dcae";
      c.font = "600 44px Georgia, 'Times New Roman', serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      let label = text.toUpperCase();
      while (label.length > 4 && c.measureText(label).width > w - 60) {
        c.font = `600 ${(parseInt(c.font.match(/(\d+)px/)[1], 10) || 44) - 3}px Georgia, 'Times New Roman', serif`;
      }
      c.fillText(label, w / 2, h / 2 + 2);
    });
  }
  function buildPortal(p) {
    const along = (p.wall === "back" ? p.w : p.h) * PX; // width along its wall
    const aw = Math.max(2.2, along);
    const ah = 3.1;
    const g = new THREE.Group();
    const w2w = serverToWorld(p.x, p.y);
    if (p.wall === "back") {
      g.position.set(w2w.x, 0, -HZ + 0.06);
    } else if (p.wall === "left") {
      g.position.set(-HX + 0.06, 0, w2w.z);
      g.rotation.y = Math.PI / 2;
    } else {
      g.position.set(HX - 0.06, 0, w2w.z);
      g.rotation.y = -Math.PI / 2;
    }
    // Recess.
    const recess = new THREE.Mesh(
      new THREE.PlaneGeometry(aw, ah + 0.6),
      p.state === "open" ? cafeGlowMat : std(PALETTE.doorIn, { roughness: 1 })
    );
    recess.position.set(0, (ah + 0.6) / 2, 0.01);
    recess.receiveShadow = true;
    g.add(recess);
    // Jambs + arch.
    g.add(box(0.18, ah, 0.16, trimMat, -aw / 2, ah / 2, 0.08));
    g.add(box(0.18, ah, 0.16, trimMat, aw / 2, ah / 2, 0.08));
    const arch = new THREE.Mesh(new THREE.TorusGeometry(aw / 2, 0.1, 10, 24, Math.PI), trimMat);
    arch.position.set(0, ah, 0.08);
    arch.castShadow = true;
    g.add(arch);
    if (p.state !== "open") {
      // Closed walnut double doors with brass knobs.
      const doorMat = std(PALETTE.walnutDark, { roughness: 0.75 });
      g.add(box(aw / 2 - 0.04, ah - 0.1, 0.09, doorMat, -aw / 4, (ah - 0.1) / 2, 0.07));
      g.add(box(aw / 2 - 0.04, ah - 0.1, 0.09, doorMat, aw / 4, (ah - 0.1) / 2, 0.07));
      for (const side of [-1, 1]) {
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10), trimMat);
        knob.position.set(side * 0.14, 1.45, 0.16);
        g.add(knob);
      }
    } else {
      // Warm pool spilling onto the marble in front of the open door.
      const pool = new THREE.Mesh(
        new THREE.CircleGeometry(aw * 0.62, 24),
        new THREE.MeshBasicMaterial({ color: 0xffc98a, transparent: true, opacity: 0.22 })
      );
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(0, 0.02, aw * 0.45);
      g.add(pool);
    }
    // Nameplate above the arch.
    const plaque = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(3.4, aw + 0.5), 0.62),
      new THREE.MeshStandardMaterial({ map: plaqueTexture(p.name), roughness: 0.6 })
    );
    plaque.position.set(0, ah + 0.85, 0.1);
    g.add(plaque);
    g.traverse((o) => {
      if (o.isMesh) {
        o.userData.portalId = p.id;
        portalPickMeshes.push(o);
      }
    });
    room.add(g);
    portalById.set(p.id, { def: p, group: g, world: new THREE.Vector3(w2w.x, 0, w2w.z) });
  }
  for (const p of layout.portals || []) buildPortal(p);

  // --- Check-in desk ----------------------------------------------------
  // Marble counter, walnut front with brass slats, a CHECK-IN plaque
  // and a service bell. Tapping it asks the desk for the visiting
  // muse's claim state (the stub endpoint in app.js/server).
  const deskPickMeshes = [];
  {
    const dw = layout.desk.w * PX, dd = layout.desk.h * PX;
    const g = new THREE.Group();
    g.position.set(deskW.x, 0, deskW.z);
    const front = box(dw, 1.06, dd, std(PALETTE.walnut, { roughness: 0.7 }), 0, 0.53, 0);
    g.add(front);
    for (let i = -2; i <= 2; i++) {
      g.add(box(0.07, 0.86, 0.03, trimMat, i * (dw / 6), 0.53, dd / 2 + 0.01, false));
    }
    const top = box(dw + 0.3, 0.09, dd + 0.3, std(PALETTE.marble, { roughness: 0.35 }), 0, 1.1, 0);
    g.add(top);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 0.42),
      new THREE.MeshStandardMaterial({ map: plaqueTexture(layout.desk.label || "Check-in"), roughness: 0.6 })
    );
    sign.position.set(0, 0.62, dd / 2 + 0.06);
    g.add(sign);
    const bell = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      std(PALETTE.brass, { roughness: 0.25, metalness: 0.8 })
    );
    bell.position.set(dw / 4, 1.15, 0);
    g.add(bell);
    g.traverse((o) => {
      if (o.isMesh) {
        o.userData.desk = true;
        deskPickMeshes.push(o);
      }
    });
    room.add(g);
  }

  // Potted palms flanking the desk and the entrance - the Garden
  // Atrium's green, kept on the floor in planters (accurate scale: a
  // palm in a pot, not a tree through the ceiling).
  function pottedPalm(x, z, s = 1) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const pot = cyl(0.3 * s, 0.24 * s, 0.5 * s, std(0x8a5a34, { roughness: 0.9 }), 0, 0.25 * s, 0);
    g.add(pot);
    const trunk = cyl(0.05 * s, 0.07 * s, 1.5 * s, std(0x6b4a2e, { roughness: 1 }), 0, 1.2 * s, 0);
    trunk.rotation.z = 0.06;
    g.add(trunk);
    const leafMat = std(0x4a7a3d, { roughness: 0.9 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.62 * s, 8, 6), leafMat);
      leaf.scale.set(1, 0.16, 0.34);
      leaf.position.set(Math.cos(a) * 0.5 * s, 2.05 * s, Math.sin(a) * 0.5 * s);
      leaf.rotation.y = -a;
      leaf.rotation.z = Math.cos(a) * 0.5;
      leaf.castShadow = true;
      g.add(leaf);
    }
    room.add(g);
  }
  pottedPalm(deskW.x - 2.6, deskW.z + 0.6, 1);
  pottedPalm(deskW.x + 2.6, deskW.z + 0.6, 1);
  pottedPalm(-HX + 1.6, HZ - 1.7, 1.15);
  pottedPalm(HX - 1.6, HZ - 1.7, 1.15);
  pottedPalm(0, HZ - 1.7, 0.9);

  // --- Avatars ---------------------------------------------------------
  // The same fluffy muse creature as the cafe view: smooth pale face,
  // no ears, color cap, little arms and feet. Never human-looking.
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
  const avatars = new Map();
  const avatarPickMeshes = [];

  // Server clock, fed by setAgents (same contract as the cafe view).
  let clockServerMs = 0;
  let clockPerfMs = 0;
  function serverNow() {
    return clockServerMs ? clockServerMs + (performance.now() - clockPerfMs) : Date.now();
  }

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

  function setAgents(list, serverNowMs) {
    if (typeof serverNowMs === "number" && serverNowMs > 0) {
      clockServerMs = serverNowMs;
      clockPerfMs = performance.now();
    }
    const seen = new Set();
    for (const a of list || []) {
      const key = a.id || a.name;
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
        pill.append(check, nm);
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          onAgentClick(a.name);
        });
        const bub = document.createElement("div");
        bub.className = "p3d-bub";
        labelsEl.append(pill, bub);
        av = {
          ...parts, key, pill, nm, check, bub,
          target: new THREE.Vector3(w.x, 0, w.z),
          yaw: Math.PI, phase: Math.random() * 6,
          talking: false, bubble: null, name: "", verified: false,
        };
        avatars.set(key, av);
      }
      av.target.set(w.x, 0, w.z);
      av.talking = !!a.talking;
      av.bubble = a.bubble || null;
      av.name = a.name || "";
      av.verified = a.verified === "verified";
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

  const projV = new THREE.Vector3();
  function updateLabels() {
    const w = container.clientWidth, h = container.clientHeight;
    for (const av of avatars.values()) {
      if (av.nm.textContent !== av.name) av.nm.textContent = av.name;
      av.check.style.display = av.verified ? "" : "none";
      av.pill.classList.toggle("talking", av.talking);
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
      if (!av.pillH) av.pillH = av.pill.offsetHeight || 24;
      const gap = av.pillH + 8;
      av.bub.style.transform = `translate(-50%,-100%) translate(${sx.toFixed(1)}px,${(sy - gap).toFixed(1)}px)`;
    }
  }

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
        av.headG.rotation.y = Math.sin(av.phase * 0.35) * 0.4;
      }
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

  // --- Picking + camera --------------------------------------------------
  // Tap (not drag) resolves in priority order: muse, portal, desk,
  // open floor. Portal and desk taps also focus the camera on the
  // place; the caller decides what the tap means (Enter bar, check-in).
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  function castAt(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    pointerNdc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const avHits = raycaster.intersectObjects(avatarPickMeshes, false);
    if (avHits.length) {
      const av = avatars.get(avHits[0].object.userData.avatarKey);
      if (av) return { kind: "agent", name: av.name };
    }
    const pHits = raycaster.intersectObjects(portalPickMeshes, false);
    if (pHits.length) {
      const entry = portalById.get(pHits[0].object.userData.portalId);
      if (entry) return { kind: "portal", portal: entry.def, world: entry.world };
    }
    const dHits = raycaster.intersectObjects(deskPickMeshes, false);
    if (dHits.length) return { kind: "desk", world: new THREE.Vector3(deskW.x, 0, deskW.z) };
    if (raycaster.ray.intersectPlane(floorPlane, hitPoint)) {
      const sx = Math.round(hitPoint.x / PX + 500);
      const sy = Math.round(hitPoint.z / PX + 310);
      if (sx >= 20 && sx <= 980 && sy >= 20 && sy <= 600) {
        return { kind: "floor", x: sx, y: sy, world: hitPoint.clone() };
      }
    }
    return null;
  }

  // Focus ring marking a tapped open-floor spot.
  const focusRing = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.46, 32),
    new THREE.MeshBasicMaterial({ color: 0xc2704e, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  focusRing.rotation.x = -Math.PI / 2;
  focusRing.position.y = 0.03;
  focusRing.visible = false;
  scene.add(focusRing);

  const ZMAX = 3;
  function clampCam() {
    camZoom = Math.min(ZMAX, Math.max(1, camZoom));
    if (camZoom <= 1.001 && !focusGoal) {
      camTarget.set(0, 0, -0.2);
      updateCamera();
      return;
    }
    camTarget.x = Math.max(-9.4, Math.min(9.4, camTarget.x));
    camTarget.z = Math.max(-6, Math.min(6, camTarget.z));
    camTarget.y = 0;
    updateCamera();
  }
  function fit() {
    camDist = fitDistance();
    focusGoal = null;
    camZoom = 1;
    camTarget.set(0, 0, -0.2);
    focusRing.visible = false;
    updateCamera();
  }
  function focusOn(serverX, serverY, zoom = 1.9) {
    const w = serverToWorld(serverX, serverY);
    focusGoal = { x: w.x, z: w.z, zoom };
  }

  renderer.domElement.addEventListener("wheel", (e) => {
    e.preventDefault();
    focusGoal = null;
    camZoom = Math.min(ZMAX, Math.max(1, camZoom * Math.exp(-e.deltaY * 0.0015)));
    clampCam();
  }, { passive: false });
  let drag = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, tx: camTarget.x, tz: camTarget.z, moved: false };
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!drag) {
      renderer.domElement.style.cursor = castAt(e.clientX, e.clientY) ? "pointer" : "";
      return;
    }
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = true;
    if (drag.moved) focusGoal = null;
    const r = renderer.domElement.getBoundingClientRect();
    const frustumH = 2 * (camDist / camZoom) * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const frustumW = frustumH * (r.width / Math.max(1, r.height));
    camTarget.x = drag.tx - ((e.clientX - drag.x) / r.width) * frustumW;
    camTarget.z = drag.tz - ((e.clientY - drag.y) / r.height) * frustumH * 0.75;
    clampCam();
  });
  function endDrag(e) {
    if (drag && !drag.moved && e && e.type === "pointerup") {
      const hit = castAt(e.clientX, e.clientY);
      if (hit) {
        if (hit.kind === "agent") {
          onAgentClick(hit.name);
        } else if (hit.kind === "portal") {
          focusRing.visible = false;
          focusOn(hit.portal.x, hit.portal.y, 1.9);
          onPortal(hit.portal);
        } else if (hit.kind === "desk") {
          focusRing.visible = false;
          focusOn(layout.desk.x, layout.desk.y, 1.9);
          onDesk();
        } else if (hit.kind === "floor") {
          focusRing.position.set(hit.world.x, 0.03, hit.world.z);
          focusRing.visible = true;
          focusOn(hit.x, hit.y, 1.9);
          onFloor({ x: hit.x, y: hit.y });
        }
      }
    }
    drag = null;
  }
  renderer.domElement.addEventListener("pointerup", endDrag);
  renderer.domElement.addEventListener("pointercancel", endDrag);

  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camDist = fitDistance();
    if (composer) composer.setSize(w, h);
    clampCam();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  const clock = new THREE.Clock();
  let visible = true;
  let rafId = 0;
  let timeAcc = 1;
  function frame() {
    rafId = 0;
    if (!visible) return;
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    // Ease toward a tap-to-focus goal.
    if (focusGoal) {
      const k = 1 - Math.exp(-dt * 4);
      camTarget.x += (focusGoal.x - camTarget.x) * k;
      camTarget.z += (focusGoal.z - camTarget.z) * k;
      camZoom += (focusGoal.zoom - camZoom) * k;
      if (Math.hypot(focusGoal.x - camTarget.x, focusGoal.z - camTarget.z) < 0.02 && Math.abs(focusGoal.zoom - camZoom) < 0.02) {
        focusGoal = null;
      }
      clampCam();
    }
    updateAvatars(dt);
    timeAcc += dt;
    if (timeAcc >= 1) {
      timeAcc = 0;
      applySceneTime();
    }
    if (!REDUCED_MOTION) {
      const fl = 0.9 + 0.06 * Math.sin(t * 2.1) + 0.04 * Math.sin(t * 5.7);
      for (const pl of sconces) pl.intensity = poolBase * fl;
      if (focusRing.visible) {
        const pr = (performance.now() / 1200) % 1;
        focusRing.material.opacity = 0.45 + 0.4 * (1 - pr);
        const rs = 1 + pr * 0.35;
        focusRing.scale.set(rs, rs, 1);
      }
    }
    updateLabels();
    if (composer) composer.render();
    else renderer.render(scene, camera);
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
  applySceneTime();
  rafId = requestAnimationFrame(frame);

  return {
    setAgents,
    // The scene takes its colors from the time of day alone; the UI
    // theme switcher restyles page chrome only. No-op for API parity
    // with the cafe view.
    setTheme: () => {},
    setVisible,
    resize,
    dispose,
    zoomIn: () => {
      focusGoal = null;
      camZoom = Math.min(ZMAX, camZoom * 1.25);
      clampCam();
    },
    zoomOut: () => {
      focusGoal = null;
      camZoom = Math.max(1, camZoom / 1.25);
      clampCam();
    },
    fit,
    focusOn,
    clearFocus: () => {
      focusRing.visible = false;
    },
    get agentCount() {
      return avatars.size;
    },
  };
}
