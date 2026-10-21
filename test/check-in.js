// Next-check countdown tests: a hello may declare check_in
// ({mode:"resident"} or {mode:"interval", seconds:N}); the server stores
// it on the agent record, serializes it as check_in + check_anchor in
// state (and state_delta), and re-anchors on hello, say, and talk.
// Agents that declare nothing get no countdown fields at all.
//   node test/check-in.js
// Exit 0 = all pass, 1 = any failure.
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18895;
const RUN = Math.random().toString(36).slice(2, 8);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? " - " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ALLOW_UNVERIFIED: "1",
      ...process.env,
      PORT: String(PORT),
      HEARTBEAT_TIMEOUT_MS: "60000",
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
      DATA_DIR: `/tmp/checkin-test-${RUN}`,
    },
    stdio: "ignore",
  });
}

function connect(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const inbox = [];
    ws.on("message", (d) => { try { inbox.push(JSON.parse(d.toString())); } catch {} });
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("error", reject);
    setTimeout(() => resolve({ ws, inbox }), 1200);
  });
}
const ofType = (inbox, t) => inbox.filter((m) => m.type === t);
function latestAgent(inbox, name) {
  const states = ofType(inbox, "state");
  if (!states.length) return null;
  const agents = states[states.length - 1].agents || [];
  return agents.find((a) => a.name === name) || null;
}
async function waitFor(fn, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(150);
  }
}

(async () => {
  const lobby = startLobby();
  await sleep(2500);
  const clients = [];
  try {
    const N = (s) => `${s}-${RUN}`;
    const t0 = Date.now();
    const a = await connect({ type: "hello", name: N("ci-poll"), serves: "t", room: "plaza", check_in: { mode: "interval", seconds: 30 } });
    const b = await connect({ type: "hello", name: N("ci-resident"), serves: "t", room: "plaza", check_in: { mode: "resident" } });
    const c = await connect({ type: "hello", name: N("ci-plain"), serves: "t", room: "plaza" });
    const d = await connect({ type: "hello", name: N("ci-bogus"), serves: "t", room: "plaza", check_in: { mode: "bogus", seconds: 5 } });
    const e = await connect({ type: "hello", name: N("ci-clamp"), serves: "t", room: "plaza", check_in: { mode: "interval", seconds: 99999 } });
    clients.push(a, b, c, d, e);

    // 1. declaration stored + serialized, absent declaration -> no fields
    const aSer = await waitFor(() => latestAgent(a.inbox, N("ci-poll")));
    check("interval agent present in state", !!aSer);
    check("interval declaration serialized",
      !!aSer && aSer.check_in && aSer.check_in.mode === "interval" && aSer.check_in.seconds === 30,
      aSer ? JSON.stringify(aSer.check_in) : "no agent");
    check("interval anchor is a fresh server timestamp",
      !!aSer && typeof aSer.check_anchor === "number" && aSer.check_anchor >= t0 - 5000 && aSer.check_anchor <= Date.now() + 5000,
      aSer ? String(aSer.check_anchor) : "no agent");

    const bSer = await waitFor(() => latestAgent(a.inbox, N("ci-resident")));
    check("resident declaration serialized",
      !!bSer && bSer.check_in && bSer.check_in.mode === "resident" && typeof bSer.check_anchor === "number",
      bSer ? JSON.stringify(bSer.check_in) : "no agent");

    const cSer = await waitFor(() => latestAgent(a.inbox, N("ci-plain")));
    check("undeclared agent present in state", !!cSer);
    check("undeclared agent has no countdown fields",
      !!cSer && !("check_in" in cSer) && !("check_anchor" in cSer),
      cSer ? Object.keys(cSer).join(",") : "no agent");

    const dSer = await waitFor(() => latestAgent(a.inbox, N("ci-bogus")));
    check("invalid declaration produces no countdown fields",
      !!dSer && !("check_in" in dSer) && !("check_anchor" in dSer),
      dSer ? JSON.stringify(dSer.check_in) : "no agent");

    const eSer = await waitFor(() => latestAgent(a.inbox, N("ci-clamp")));
    check("interval seconds clamped to 86400",
      !!eSer && eSer.check_in && eSer.check_in.seconds === 86400,
      eSer ? JSON.stringify(eSer.check_in) : "no agent");

    // 2. anchor advances on say
    const anchor1 = aSer.check_anchor;
    await sleep(1100);
    a.ws.send(JSON.stringify({ type: "say", from: N("ci-poll"), text: `anchor probe ${RUN}` }));
    const aSer2 = await waitFor(() => {
      const s = latestAgent(a.inbox, N("ci-poll"));
      return s && s.check_anchor > anchor1 ? s : null;
    });
    check("say re-anchors the countdown", !!aSer2, `anchor ${anchor1} -> ${aSer2 ? aSer2.check_anchor : "unchanged"}`);

    // 3. anchor advances on talk (speaker side)
    const bAnchor1 = latestAgent(a.inbox, N("ci-resident")).check_anchor;
    await sleep(1100);
    b.ws.send(JSON.stringify({ type: "talk", from: N("ci-resident"), to: N("ci-poll"), text: `talk anchor probe ${RUN}` }));
    const bSer2 = await waitFor(() => {
      const s = latestAgent(a.inbox, N("ci-resident"));
      return s && s.check_anchor > bAnchor1 ? s : null;
    });
    check("talk re-anchors the countdown", !!bSer2, `anchor ${bAnchor1} -> ${bSer2 ? bSer2.check_anchor : "unchanged"}`);

    // 4. state_delta carries the countdown fields when the anchor moves
    const f = await connect({ type: "hello", kind: "viewer", room: "plaza", agent_name: N("ci-obs"), accepts_deltas: true });
    clients.push(f);
    check("delta viewer got a full snapshot first", ofType(f.inbox, "state").length >= 1);
    const anchorBefore = latestAgent(a.inbox, N("ci-poll")).check_anchor;
    f.inbox.length = 0;
    await sleep(1100);
    a.ws.send(JSON.stringify({ type: "say", from: N("ci-poll"), text: `delta anchor probe ${RUN}` }));
    const hit = await waitFor(() => {
      const deltas = ofType(f.inbox, "state_delta");
      return deltas.find((dl) => (dl.agents_changed || []).some(
        (x) => x.name === N("ci-poll") && x.check_in && x.check_in.mode === "interval" && x.check_anchor > anchorBefore
      )) || null;
    });
    check("state_delta carries check_in + advanced check_anchor", !!hit);

    for (const cl of clients) { try { cl.ws.close(); } catch {} }
  } finally {
    lobby.kill("SIGKILL");
  }
  await sleep(300);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
