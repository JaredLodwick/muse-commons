// Places discovery layer tests: room categories, /places page, /api/places,
// geo room seeds, intro post kind (human_approved guardrail), intro matchmaking.
//
// Spawns a real lobby server child.
//   node test/places.js
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18782;

const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;

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
      if (out.includes("listening")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
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
function openAgent(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [] };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, ...extra })));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      rec.msgs.push(m);
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
        clearTimeout(timer);
        resolve(rec);
      }
      if (m.type === "error" && !rec.helloDone) {
        clearTimeout(timer);
        resolve(rec);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
function waitFor(rec, pred, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const found = rec.msgs.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const onMsg = (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (pred(m)) {
        clearTimeout(timer);
        rec.ws.off("message", onMsg);
        resolve(m);
      }
    };
    rec.ws.on("message", onMsg);
  });
}
function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}
function sendAndWait(rec, msg, pred, timeoutMs = 6000) {
  rec.ws.send(JSON.stringify(msg));
  return waitFor(rec, pred, timeoutMs);
}

async function main() {
  const server = startLobby();
  await waitForListening(server);

  console.log("places page + api");
  {
    const r = await get("/places");
    check("/places 200", r.status === 200, `got ${r.status}`);
    check("/places mentions Places", r.body.includes("<h1>Places</h1>"));
    check("/places has category chips", r.body.includes('data-cat="local"') && r.body.includes('data-cat="interest"'));
  }
  {
    const r = await get("/api/places");
    check("/api/places 200", r.status === 200, `got ${r.status}`);
    const data = JSON.parse(r.body);
    const rooms = data.rooms || [];
    const byId = Object.fromEntries(rooms.map((x) => [x.room_id, x]));
    check("16 seeded rooms", rooms.length === 16, `got ${rooms.length}`);
    const expected = {
      plaza: "utility", marketplace: "utility", introductions: "utility", help: "utility",
      tech: "interest", food: "interest", travel: "interest", music: "interest",
      books: "interest", random: "interest",
      "bay-area": "local", "new-york": "local", "los-angeles": "local",
      seattle: "local", london: "local", tokyo: "local",
    };
    let catsOk = true;
    for (const [id, cat] of Object.entries(expected)) {
      if (!byId[id] || byId[id].category !== cat) {
        catsOk = false;
        console.log(`    room ${id}: expected ${cat}, got ${byId[id] && byId[id].category}`);
      }
    }
    check("room categories correct", catsOk);
    check("descriptions present", rooms.every((x) => typeof x.description === "string" && x.description.length > 0));
    check("occupancy present", rooms.every((x) => typeof x.occupancy === "number"));
  }

  console.log("filter predicate (mirrors web/places.html)");
  {
    // Extract the actual shipped predicate from places.html so the test
    // covers the real filtering logic, not a copy.
    const html = fs.readFileSync(path.join(REPO, "web", "places.html"), "utf8");
    const m = html.match(/function roomMatches\(r, cat, q\) \{[\s\S]*?\n\}/);
    check("predicate extractable from places.html", !!m);
    const roomMatches = eval(`(${m[0]})`);
    const r1 = { topic: "#bay-area", description: "SF Bay Area — muses and humans", category: "local" };
    const r2 = { topic: "#tech", description: "Gadgets, AI, programming", category: "interest" };
    check("category filter", roomMatches(r1, "local", "") && !roomMatches(r1, "interest", ""));
    check("all passes", roomMatches(r2, "all", ""));
    check("search topic", roomMatches(r1, "all", "bay"));
    check("search description", roomMatches(r2, "all", "gadgets"));
    check("search miss", !roomMatches(r1, "all", "cameras"));
    check("category+search combo", roomMatches(r1, "local", "area") && !roomMatches(r2, "local", "area"));
  }

  console.log("create_room category");
  {
    const a = await openAgent("CatTester" + RUN);
    const ok = await sendAndWait(
      a, { type: "create_room", topic: "Geo breakout " + RUN, category: "local" },
      (m) => m.type === "room_created"
    );
    check("create_room accepts category local", !!ok && ok.category === "local", JSON.stringify(ok && ok.category));
    const bad = await sendAndWait(
      a, { type: "create_room", topic: "Bad cat " + RUN, category: "bogus" },
      (m) => m.type === "room_created" && m.topic === "Bad cat " + RUN
    );
    check("invalid category defaults to interest", !!bad && bad.category === "interest", JSON.stringify(bad && bad.category));
    a.ws.close();
  }

  console.log("intro posts");
  const posters = []; // {rec, id} for cleanup
  const trackPost = (rec, okMsg) => {
    if (okMsg && okMsg.id) posters.push({ rec, id: okMsg.id });
  };
  {
    const muse = await openAgent("IntroMuse" + RUN, { serves: "Human" + RUN });
    // 1. intro without human_approved -> rejected
    const err = await sendAndWait(
      muse,
      { type: "post", kind: "intro", topics: [T("cameras")], title: "Human into vintage cameras" },
      (m) => m.type === "error"
    );
    check("intro without human_approved rejected", !!err && /human_approved/.test(err.message || ""), err && err.message);
    // 2. intro with human_approved -> post_ok
    const ok = await sendAndWait(
      muse,
      { type: "post", kind: "intro", topics: [T("cameras")], title: "Human into vintage cameras", human_approved: true },
      (m) => m.type === "post_ok"
    );
    check("intro with human_approved accepted", !!ok, JSON.stringify(ok && ok.type));
    trackPost(muse, ok);
    // 3. appears on /api/board as intro
    const b = await get("/api/board");
    const posts = JSON.parse(b.body).posts || [];
    const mine = posts.find((p) => p.title === "Human into vintage cameras");
    check("intro on /api/board", !!mine && mine.kind === "intro" && mine.human_approved === true);
  }

  console.log("intro matchmaking");
  {
    const a1 = await openAgent("IntroA" + RUN);
    const a2 = await openAgent("IntroB" + RUN);
    const topic = T("hiking");
    const p1 = await sendAndWait(
      a1, { type: "post", kind: "intro", topics: [topic], title: "Human hikes", human_approved: true },
      (m) => m.type === "post_ok"
    );
    trackPost(a1, p1);
    const p2 = await sendAndWait(
      a2, { type: "post", kind: "intro", topics: [topic], title: "Human also hikes", human_approved: true },
      (m) => m.type === "post_ok"
    );
    trackPost(a2, p2);
    const m1 = await waitFor(a1, (m) => m.type === "match");
    const m2 = await waitFor(a2, (m) => m.type === "match");
    check("intro+intro overlap -> match for both", !!m1 && !!m2);
    check("match room ids agree", !!m1 && !!m2 && m1.room_id === m2.room_id, `${m1 && m1.room_id} vs ${m2 && m2.room_id}`);
    check("match kind is intro", !!m1 && m1.other && m1.other.kind === "intro");
    // intro must NOT match want/offer
    const seller = await openAgent("SellerX" + RUN);
    const w = await sendAndWait(
      seller,
      { type: "post", kind: "offer", topics: [T("hiking2")], title: "Selling boots" },
      (m) => m.type === "post_ok"
    );
    trackPost(seller, w);
    const buyer = await openAgent("IntroC" + RUN);
    const pi = await sendAndWait(
      buyer,
      { type: "post", kind: "intro", topics: [T("hiking2")], title: "Human hikes too", human_approved: true },
      (m) => m.type === "post_ok"
    );
    trackPost(buyer, pi);
    const noMatch = await waitFor(seller, (m) => m.type === "match", 2500);
    check("intro does NOT match offer", !noMatch);
  }

  // cleanup: each poster closes their own posts, then close sockets
  {
    let closed = 0;
    for (const { rec, id } of posters) {
      const done = await sendAndWait(rec, { type: "close_post", id }, (m) => m.type === "post_closed" && m.id === id, 4000);
      if (done) closed++;
    }
    check("test posts closed", closed === posters.length, `${closed}/${posters.length}`);
    const seen = new Set();
    for (const { rec } of posters) {
      if (!seen.has(rec)) {
        seen.add(rec);
        rec.ws.close();
      }
    }
  }

  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e.message);
  process.exit(1);
});
