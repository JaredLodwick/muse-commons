// 3D plaza tests: module integrity, world-coordinate contract, static serving.
//
// The WebGL scene itself can't run headless, so this covers what node can:
// the module imports, its server->world mapping matches the lobby's 1000x620
// room, and the server delivers the new frontend files with the right MIME.
//
//   node test/plaza3d.js
//
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18860;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ALLOW_UNVERIFIED: "1",
      ...process.env,
      PORT: String(PORT),
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${c}: ${out}`));
    });
  });
}

function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks) })
        );
      })
      .on("error", reject);
  });
}

async function main() {
  console.log("3d plaza module");

  // 1. The module imports under node (as .mjs; browsers load the .js bytes
  // directly) and exports the view factory + coordinate mapping.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plaza3d-"));
  fs.copyFileSync(path.join(REPO, "web", "plaza3d.js"), path.join(tmp, "plaza3d.mjs"));
  fs.copyFileSync(path.join(REPO, "web", "three.module.min.js"), path.join(tmp, "three.module.min.js"));
  let mod = null;
  try {
    mod = await import(pathToFileURL(path.join(tmp, "plaza3d.mjs")).href);
  } catch (e) {
    check("module imports", false, e.message);
  }
  check("module imports", !!mod);
  check("exports createPlazaView", !!mod && typeof mod.createPlazaView === "function");
  check("exports serverToWorld", !!mod && typeof mod.serverToWorld === "function");

  // 2. Coordinate contract: server (1000x620, y-down) -> floor units, center
  // at the origin, 1 unit = 50px. Must match ROOM in server/lobby.js and
  // WORLD in web/app.js.
  if (mod) {
    const eq = (a, b) => Math.abs(a - b) < 1e-9;
    const c = mod.serverToWorld(500, 310);
    check("center maps to origin", eq(c.x, 0) && eq(c.z, 0), JSON.stringify(c));
    const tl = mod.serverToWorld(0, 0);
    check("top-left maps to (-10,-6.2)", eq(tl.x, -10) && eq(tl.z, -6.2), JSON.stringify(tl));
    const br = mod.serverToWorld(1000, 620);
    check("bottom-right maps to (10,6.2)", eq(br.x, 10) && eq(br.z, 6.2), JSON.stringify(br));
    const mid = mod.serverToWorld(250, 155);
    check("quarter maps to (-5,-3.1)", eq(mid.x, -5) && eq(mid.z, -3.1), JSON.stringify(mid));
  }

  // 2b. Time of day: the pure sky function. Noon / midnight / dawn in
  // Commons time (Pacific), the sun-moon handoff on the one directional
  // light, and twilight as a blend rather than a step.
  if (mod) {
    check("exports plazaTimeOfDay", typeof mod.plazaTimeOfDay === "function");
    const ch = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
    const noon = mod.plazaTimeOfDay(12);
    check("noon is full day", noon.dayFactor === 1, String(noon.dayFactor));
    check("noon sun at full intensity", noon.sun.intensity >= 1.59, String(noon.sun.intensity));
    const [nr, ng, nb] = ch(noon.sun.color);
    check("noon sun is warm white", nr > 230 && ng > 210 && nb > 180, noon.sun.color.toString(16));
    check("noon sun is high", noon.sun.pos[1] > 12, JSON.stringify(noon.sun.pos));
    check("noon sky is the warm day background", noon.bg === 0xe9dcc4, noon.bg.toString(16));
    check("noon directional light is the sun", noon.dir.intensity >= 1.59 && noon.dir.color === noon.sun.color);
    const mid = mod.plazaTimeOfDay(0);
    check("midnight is full night", mid.dayFactor === 0, String(mid.dayFactor));
    check("midnight sun is off", mid.sun.intensity === 0, String(mid.sun.intensity));
    check(
      "midnight moon takes the directional light",
      mid.dir.intensity >= 0.25 && mid.dir.color === 0x8fb4ff,
      `${mid.dir.intensity} / ${mid.dir.color.toString(16)}`
    );
    const [mr, , mb] = ch(mid.bg);
    check("midnight sky is deep blue", mb > mr, mid.bg.toString(16));
    check(
      "midnight ambience is dimmer than noon",
      mid.ambInt < noon.ambInt && mid.hemiInt < noon.hemiInt,
      `${mid.ambInt}/${mid.hemiInt} vs ${noon.ambInt}/${noon.hemiInt}`
    );
    check("midnight table pools burn brighter", mid.poolInt > noon.poolInt, `${mid.poolInt} vs ${noon.poolInt}`);
    const dawn = mod.plazaTimeOfDay(6.5);
    check("dawn is a blend, not a step", dawn.dayFactor > 0 && dawn.dayFactor < 1, String(dawn.dayFactor));
    check("dawn sun is low", dawn.sun.pos[1] < 6 && dawn.sun.pos[1] > 0, JSON.stringify(dawn.sun.pos));
    const [dr, , db] = ch(dawn.sun.color);
    check("dawn sun is orange", dr > 200 && db < 150, dawn.sun.color.toString(16));
    const wrapped = mod.plazaTimeOfDay(24 + 6.5);
    check("hour wraps past 24", wrapped.dayFactor === dawn.dayFactor && wrapped.hour === 6.5);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // 3. The lobby serves the new frontend files with JavaScript MIME types,
  // and the index page mounts the 3D container.
  const server = startLobby();
  try {
    await waitForListening(server);
    const plaza = await get("/plaza3d.js");
    check("GET /plaza3d.js -> 200", plaza.status === 200, String(plaza.status));
    check("plaza3d.js served as javascript", (plaza.type || "").includes("javascript"), plaza.type);
    check(
      "plaza3d.js body defines the view",
      plaza.body.toString("utf8", 0, 200000).includes("createPlazaView")
    );
    const src = plaza.body.toString("utf8");
    check("no hanging lamp fixtures", !/pendant|shadeMat|bulbMat/i.test(src));
    check("invisible table lights present", src.includes("PointLight") && /tableLights/.test(src));
    check(
      "scene ignores the UI theme switcher",
      !src.includes("0x141019") && /setTheme:\s*\(\)\s*=>\s*\{\}/.test(src)
    );
    check("Commons time is Pacific", src.includes("America/Los_Angeles"));
    check("time scrub control ships", src.includes("p3d-time") && src.includes('"1439"'));
    check("no room portals along the front", !/doorSlots|doorLabelTexture|setDoors|onDoorClick/i.test(src));
    const three = await get("/three.module.min.js");
    check("GET /three.module.min.js -> 200", three.status === 200, String(three.status));
    check("three served as javascript", (three.type || "").includes("javascript"), three.type);
    check("vendored three looks complete (>500KB)", three.body.length > 500 * 1024, String(three.body.length));
    const index = await get("/");
    check("GET / -> 200", index.status === 200, String(index.status));
    const html = index.body.toString("utf8");
    check("index mounts #room3d", html.includes('id="room3d"'));
    check("index still loads app.js", html.includes('src="app.js"'));
  } finally {
    server.kill();
  }

  if (failures) {
    console.log(`${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("all plaza3d checks passed");
}

main().catch((e) => {
  console.error("ERROR", e);
  process.exit(1);
});
