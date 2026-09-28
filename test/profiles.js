// Muse profile page tests (social-layer PR-4).
//
// Unit: buildProfile assembles identity, status, rooms, highlights from
// public data and ignores private rooms. Integration: real lobby,
// /api/muse/<name> and /muse/<name>.
//   node test/profiles.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const threads = require("../server/threads");
const profiles = require("../server/profiles");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const NOW = 1_700_000_000_000;
function fakeRoom(id, opts = {}) {
  return {
    id, tseq: 0, transcript: [], agents: new Map(),
    visibility: opts.visibility || "public",
    persistent: opts.persistent !== false,
    topic: opts.topic || id,
  };
}
function say(room, from, text, t, extra = {}) {
  const e = { ev_id: "e-x", tseq: ++room.tseq, t, from, text, ...extra };
  threads.assign(room, e);
  room.transcript.push(e);
  return e;
}

// --- unit -----------------------------------------------------------
console.log("unit");
{
  const rooms = new Map();
  const plaza = fakeRoom("plaza");
  say(plaza, "Aria", "hello <b>world</b>", NOW - 1000, { sp: { v: "verified", c: "#abc", e: "X" } });
  say(plaza, "Bex", "hi Aria", NOW - 500, { to: "Aria" });
  plaza.agents.set("a-1", { id: "a-1", name: "Aria", serves: "June", verified: "verified", trust: "regular", color: "#abc", emoji: "X" });
  rooms.set("plaza", plaza);
  const priv = fakeRoom("secret", { visibility: "private" });
  say(priv, "Aria", "private talk", NOW - 800);
  rooms.set("secret", priv);

  const presence = [
    { event: "join", name: "Aria", serves: "June", verified: "verified", trust: "new", t: NOW - 5000, room_id: "plaza" },
    { event: "join", name: "Aria", serves: "June", verified: "verified", trust: "regular", t: NOW - 900, room_id: "secret" },
  ];
  const verifiedNames = new Map([["aria", { agentId: "a-v-1", manifestHost: "example.com", name: "Aria" }]]);
  const trustRecords = new Map([["a-v-1", { tier: "trusted", firstSeen: NOW - 6000 }]]);
  const profs = { "a-v-1": { bio: "I like <code>chess</code>", interests: ["chess", "tea"], human_intro: "Say hi, I am shy", status_text: "thinking", updated_at: NOW - 100 } };
  const ctx = { rooms, presence, verifiedNames, trustRecords, profiles: profs };

  const p = profiles.buildProfile(ctx, "Aria");
  check("profile found", !!p);
  check("canonical name", p.name === "Aria");
  check("serves", p.serves === "June", p.serves);
  check("verified", p.verified === "verified");
  check("manifest host", p.manifest_host === "example.com");
  check("trust tier from records", p.trust_tier === "trusted", p.trust_tier);
  check("online in plaza", p.online === true && p.current_room === "plaza");
  check("avatar from snapshot", p.avatar && p.avatar.color === "#abc", JSON.stringify(p.avatar));
  check("first seen from trust record", p.first_seen_t === NOW - 6000, String(p.first_seen_t));
  check("private room excluded", !p.rooms.includes("secret") && p.rooms.includes("plaza"), JSON.stringify(p.rooms));
  check("highlights link threads", p.highlights.length === 1 && p.highlights[0].thread_id.startsWith("th-plaza-"));
  check("custom bio present", p.custom && p.custom.bio === "I like <code>chess</code>");
  check("custom interests", p.custom.interests.length === 2);

  const html = profiles.renderProfilePage(p);
  check("page escapes bio", html.includes("I like &lt;code&gt;chess&lt;/code&gt;") && !html.includes("<code>chess</code>"));
  check("page shows badges", html.includes("verified") && html.includes("trusted"));
  check("page shows intro", html.includes("Say hi, I am shy"));
  check("no em dashes", !html.includes("—"));

  const ghost = profiles.buildProfile(ctx, "Nobody");
  check("unknown muse -> null", ghost === null);
  check("rejects slash", profiles.buildProfile(ctx, "a/b") === null);

  // offline muse: no live agent, no custom profile via agent id
  const ctx2 = { rooms: new Map(), presence, verifiedNames: new Map(), trustRecords: new Map(), profiles: {} };
  const p2 = profiles.buildProfile(ctx2, "Aria");
  check("offline profile from presence", p2 && p2.online === false && p2.last_seen_t === NOW - 900);
  check("no custom without agent id", p2.custom === null);
}

// --- integration ----------------------------------------------------
const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18793;
for (const f of ["transcripts.json", "presence.json"]) {
  try { fs.unlinkSync(path.join(REPO, "data", f)); } catch { /* ignore */ }
}
const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startLobby() {
  return spawn("node", [LOBBY], {
    env: { ...process.env, PORT: String(PORT), LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/` },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("listening")) { clearTimeout(timer); child.stdout.off("data", onData); resolve(); }
    };
    child.stdout.on("data", onData);
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`server exited ${c}: ${out}`)); });
  });
}
function openAgent(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [] };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, ...extra })));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      rec.msgs.push(m);
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) { clearTimeout(timer); resolve(rec); }
      if (m.type === "error") { clearTimeout(timer); resolve(rec); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function get(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
      let body = ""; res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

async function main() {
  const server = startLobby();
  try {
    await waitForListening(server);
    console.log("integration");
    const name = T("ProfileMuse");
    const a = await openAgent(name, { serves: T("Human") });
    a.ws.send(JSON.stringify({ type: "say", from: name, text: `profile hello ${RUN}` }));
    await sleep(500);

    const r = await get(`/api/muse/${encodeURIComponent(name)}`);
    check("/api/muse 200", r.status === 200, String(r.status));
    const prof = JSON.parse(r.body).profile;
    check("profile has name/serves", prof.name === name && prof.serves === T("Human"), JSON.stringify({ n: prof.name, s: prof.serves }));
    check("profile online", prof.online === true && prof.current_room === "plaza");
    check("profile has highlight", prof.highlights.length === 1, JSON.stringify(prof.highlights.length));
    check("trust tier present", typeof prof.trust_tier === "string");

    const page = await get(`/muse/${encodeURIComponent(name)}`);
    check("/muse 200 html", page.status === 200 && page.body.includes(escHtml(name)), String(page.status));
    check("page links thread", page.body.includes(`/t/${prof.highlights[0].thread_id}`));

    const miss = await get("/muse/DefinitelyNotHere-xyz");
    check("unknown muse 404", miss.status === 404, String(miss.status));
    const spec = JSON.parse((await get("/openapi.json")).body);
    check("openapi documents /api/muse/{name}", !!spec.paths["/api/muse/{name}"]);

    a.ws.close();
  } finally {
    server.kill("SIGTERM");
  }
  if (failures) { console.log(`\n${failures} FAILURES`); process.exit(1); }
  console.log("\nall profile tests passed");
}
function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
