// Phase 2 tests: @mention notifications.
//
// Spawns a real lobby server child and exercises mention parsing,
// targeted live events, the durable record, and the pull endpoint.
//
//   node test/mentions.js
//
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18791;
const HOST_FIXTURE_PORT = 18792;

// Verified-host fixture (for the quarantine test), same pattern as
// test/board.js: the fixture manifest carries a real Ed25519 key.
const { privateKey: HOST_PRIV, publicKey: HOST_PUB } = crypto.generateKeyPairSync("ed25519");
const HOST_PUB_B64 = Buffer.from(HOST_PUB.export({ format: "jwk" }).x, "base64url").toString("base64");
const HOST_MANIFEST_URL = `http://127.0.0.1:${HOST_FIXTURE_PORT}/.well-known/muse-protocol.json`;
const hostFixture = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      muse: { name: "HostMuse", serves: "Host" },
      signing_key: { alg: "ed25519", key_id: "host-fixture-1", pubkey: HOST_PUB_B64 },
    })
  );
});
function signHostChallenge(nonce) {
  return crypto
    .sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), HOST_PRIV)
    .toString("base64");
}

const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : " " + detail}`);
  }
}

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ALLOW_UNVERIFIED: "1",
      ...process.env,
      PORT: String(PORT),
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
      HOST_MUSE: "HostMuse",
      MANIFEST_ALLOW_PRIVATE: "1",
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
    const rec = { ws, name, msgs: [], agentId: null };
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
      if (m.type === "hello_ok") rec.agentId = m.agent_id;
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
        clearTimeout(timer);
        resolve(rec);
      }
      if (m.type === "error" && !rec.agentId) {
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

function openVerifiedAgent(name, manifestUrl, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [], agentId: null };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 15000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, manifest_url: manifestUrl, ...extra })));
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      rec.msgs.push(m);
      if (m.type === "challenge") {
        ws.send(
          JSON.stringify({
            type: "challenge_response",
            challenge_id: m.challenge_id,
            signature: signHostChallenge(m.nonce),
          })
        );
        return;
      }
      if (m.type === "hello_ok") rec.agentId = m.agent_id;
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
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

function getJson(p) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sayAs(rec, text) {
  rec.ws.send(JSON.stringify({ type: "say", from: rec.name, text }));
}
const mentionEvents = (rec) => rec.msgs.filter((m) => m.type === "event" && m.event === "mention");

async function main() {
  await new Promise((r) => hostFixture.listen(HOST_FIXTURE_PORT, "127.0.0.1", r));
  const lobby = startLobby();
  await waitForListening(lobby);

  const alice = await openAgent(T("MenAlice"));
  const bob = await openAgent(T("MenBob"));
  const carol = await openAgent(T("MenCarol"));
  check("agents join", alice.agentId && bob.agentId && carol.agentId);

  // 1. basic mention: targeted event to Bob, nobody else
  const bobBefore = mentionEvents(bob).length;
  sayAs(alice, `hey @${T("MenBob")}, how are you?`);
  const ev = await waitFor(bob, (m) => m.type === "event" && m.event === "mention" && mentionEvents(bob).length > bobBefore);
  check("mention event delivered to the named agent", !!ev);
  check("enriched payload", !!ev && ev.from === T("MenAlice") && ev.to === T("MenBob") && !!ev.mention_id && ev.room_id === "plaza" && typeof ev.created_at === "number" && ev.text.includes("how are you"), JSON.stringify(ev && { from: ev.from, to: ev.to, mention_id: ev.mention_id }));
  await sleep(800);
  check("non-mentioned agents get nothing", mentionEvents(carol).length === 0 && mentionEvents(alice).length === 0, `carol=${mentionEvents(carol).length} alice=${mentionEvents(alice).length}`);

  // 2. unknown name: skipped silently, message still sends
  const bobCount2 = mentionEvents(bob).length;
  sayAs(alice, "hey @NobodyHere-Zzz, you there?");
  const ok2 = await waitFor(alice, (m) => m.type === "say_ok");
  await sleep(800);
  check("unknown name skipped without error", !!ok2 && mentionEvents(bob).length === bobCount2);

  // 3. near-miss: @Al does not notify Alice
  const al = await openAgent(T("MenAl"));
  const aliceFull = await openAgent(T("MenAliceFull"));
  const alBefore = mentionEvents(al).length;
  const afBefore = mentionEvents(aliceFull).length;
  sayAs(bob, `hi @${T("MenAl")} welcome`);
  await waitFor(al, (m) => m.type === "event" && m.event === "mention" && mentionEvents(al).length > alBefore);
  await sleep(800);
  check("@Al notifies Al", mentionEvents(al).length === alBefore + 1);
  check("@Al does not notify AliceFull", mentionEvents(aliceFull).length === afBefore, `got ${mentionEvents(aliceFull).length - afBefore}`);

  // 4. ambiguous: two occupants sharing a display name both get it
  const sam1 = await openAgent(T("MenSam"));
  const sam2 = await openAgent(T("MenSam"));
  const s1b = mentionEvents(sam1).length;
  const s2b = mentionEvents(sam2).length;
  sayAs(carol, `hello @${T("MenSam")}`);
  await waitFor(sam1, (m) => m.type === "event" && m.event === "mention" && mentionEvents(sam1).length > s1b);
  await sleep(800);
  check("ambiguous name notifies all matching occupants", mentionEvents(sam1).length === s1b + 1 && mentionEvents(sam2).length === s2b + 1, `sam1=${mentionEvents(sam1).length - s1b} sam2=${mentionEvents(sam2).length - s2b}`);

  // 5. self-mention: no event
  const selfBefore = mentionEvents(alice).length;
  sayAs(alice, `note to self @${T("MenAlice")}`);
  await waitFor(alice, (m) => m.type === "say_ok");
  await sleep(800);
  check("self-mention produces no event", mentionEvents(alice).length === selfBefore);

  // 6. double mention in one message: one event, one durable record
  const dblBefore = mentionEvents(bob).length;
  const durBefore = JSON.parse((await getJson(`/api/mentions?for=${bob.agentId}`)).body).mentions.length;
  sayAs(alice, `@${T("MenBob")} one @${T("MenBob")} two`);
  await waitFor(bob, (m) => m.type === "event" && m.event === "mention" && mentionEvents(bob).length > dblBefore);
  await sleep(800);
  check("double mention yields one event", mentionEvents(bob).length === dblBefore + 1);
  const durAfter = JSON.parse((await getJson(`/api/mentions?for=${bob.agentId}`)).body).mentions.length;
  check("double mention yields one durable record", durAfter === durBefore + 1, `${durBefore} -> ${durAfter}`);

  // 7. cap: 7 named occupants, exactly 5 notified, in order of appearance
  const extras = [];
  for (let i = 0; i < 7; i++) extras.push(await openAgent(T(`MenCap${i}`)));
  const capBefore = extras.map((e) => mentionEvents(e).length);
  const capText = extras.map((e) => `@${e.name}`).join(" ");
  sayAs(alice, capText);
  await sleep(1500);
  const capAfter = extras.map((e, i) => mentionEvents(e).length - capBefore[i]);
  check(
    "per-message cap notifies exactly 5 in order",
    capAfter.slice(0, 5).every((n) => n === 1) && capAfter.slice(5).every((n) => n === 0),
    capAfter.join(",")
  );

  // 8. durable record readable after the fact
  const byName = await getJson(`/api/mentions?for_name=${encodeURIComponent(T("MenBob"))}`);
  check("GET /api/mentions?for_name= 200", byName.status === 200, byName.status);
  const list = JSON.parse(byName.body).mentions;
  const keys = list.length ? Object.keys(list[0]).sort() : [];
  check(
    "record has public fields, no identity ids",
    list.length > 0 && list[0].from === T("MenAlice") && typeof list[0].text === "string" && list[0].room_id === "plaza" &&
      JSON.stringify(keys) === JSON.stringify(["created_at", "from", "id", "room_id", "serves", "text"]),
    JSON.stringify(keys)
  );
  const byId = await getJson(`/api/mentions?for=${bob.agentId}&limit=1`);
  check("for=<id> with limit works", byId.status === 200 && JSON.parse(byId.body).mentions.length === 1);
  const noTarget = await getJson(`/api/mentions`);
  check("missing target -> 400 MENTION_TARGET_REQUIRED", noTarget.status === 400 && JSON.parse(noTarget.body).error === "MENTION_TARGET_REQUIRED");
  const sinceTs = Date.now();
  await sleep(50);
  sayAs(alice, `@${T("MenBob")} fresh one`);
  await waitFor(bob, (m) => m.type === "event" && m.event === "mention" && m.text.includes("fresh one"));
  const sinceRes = JSON.parse((await getJson(`/api/mentions?for=${bob.agentId}&since=${sinceTs}`)).body).mentions;
  check("since= filters", sinceRes.length === 1 && sinceRes[0].text.includes("fresh one"), sinceRes.length);

  // 9. quarantine blocks
  const qHost = await openVerifiedAgent("HostMuse", HOST_MANIFEST_URL);
  const noisy = await openAgent(T("MenNoisy"));
  qHost.ws.send(JSON.stringify({ type: "quarantine", agent: noisy.name }));
  const qok = await waitFor(qHost, (m) => m.type === "quarantine_ok");
  check("quarantine test setup", !!qok);
  const qBobBefore = mentionEvents(bob).length;
  sayAs(noisy, `hey @${T("MenBob")} held`);
  const qErr = await waitFor(noisy, (m) => m.type === "error" && m.code === "QUARANTINED");
  await sleep(800);
  check("quarantined mentioner blocked", !!qErr && mentionEvents(bob).length === qBobBefore);
  const qDur = JSON.parse((await getJson(`/api/mentions?for=${bob.agentId}&since=${Date.now() - 5000}`)).body).mentions;
  check("quarantined mention not recorded", !qDur.some((m) => m.text.includes("held")));
  qHost.ws.send(JSON.stringify({ type: "release", agent: noisy.name }));
  await waitFor(qHost, (m) => m.type === "released" || m.type === "release_ok");

  for (const a of [alice, bob, carol, al, aliceFull, sam1, sam2, noisy, qHost, ...extras]) {
    try { a.ws.close(); } catch {}
  }
  lobby.kill();
  hostFixture.close();

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
