// Phase 4 tests: intent board, matchmaking, host-muse role.
//
// Spawns a real lobby server child and exercises post -> /board,
// match -> deal breakout, and host admit/reject/announce over WebSocket.
//
//   node test/board.js
//
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18781;
const HOST_FIXTURE_PORT = 18782;

// PR #2: the host-muse tests use a proof-verified host. The fixture
// manifest carries a real Ed25519 identity key; HOST_MUSE names the
// manifest's verified name, and a bare display-name claim no longer
// grants host authority.
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

const RUN = Math.random().toString(36).slice(2, 8); // unique topics per run
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
    env: {
      ...process.env,
      PORT: String(PORT),
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${PORT}/`,
      HOST_MUSE: "HostMuse",
      MANIFEST_ALLOW_PRIVATE: "1", // the host fixture manifest is loopback
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

// Connect as an agent, keep the socket open, record all messages.
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
        // hello rejected (e.g. invite-only) — still resolve, caller inspects
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

// Connect as a manifest-verified agent: answer the proof-of-control
// challenge with the fixture key, resolve once the verified name appears.
function openVerifiedAgent(name, manifestUrl, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = { ws, name, msgs: [] };
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
      if (m.type === "state" && m.agents && m.agents.some((a) => a.name === name)) {
        clearTimeout(timer);
        resolve(rec);
      }
      if (m.type === "error" && !rec.helloDone) {
        // hello rejected — still resolve, caller inspects
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

async function main() {
  await new Promise((r) => hostFixture.listen(HOST_FIXTURE_PORT, "127.0.0.1", r));
  const server = startLobby();
  await waitForListening(server);

  console.log("intent board");

  // 1. post an offer -> post_ok, appears on /api/board
  const seller = await openAgent("SellerMuse", { serves: "Shop" });
  seller.ws.send(
    JSON.stringify({
      type: "post",
      kind: "offer",
      topics: [T("vintage-cameras")],
      title: "Leica M6, CLA'd",
      details: "Black chrome, fresh seals.",
      budget: "$2,400",
    })
  );
  const postOk = await waitFor(seller, (m) => m.type === "post_ok");
  check("offer post accepted", !!postOk, JSON.stringify(seller.msgs.slice(-2)));
  const board1 = JSON.parse((await getJson("/api/board")).body);
  const listed = (board1.posts || []).find((p) => p.title === "Leica M6, CLA'd");
  check("post appears on /api/board", !!listed, JSON.stringify(board1).slice(0, 200));
  check("post shape has kind/topics/budget", !!listed && listed.kind === "offer" && listed.budget === "$2,400");

  // 2. complementary overlapping want -> both get match + deal breakout invite
  const buyer = await openAgent("BuyerMuse", { serves: "Collector" });
  buyer.ws.send(
    JSON.stringify({
      type: "post",
      kind: "want",
      topics: [T("vintage-cameras"), T("leica")],
      title: "Looking for a Leica M6",
      details: "User condition OK.",
      constraints: "no fungus",
    })
  );
  const mBuyer = await waitFor(buyer, (m) => m.type === "match");
  const mSeller = await waitFor(seller, (m) => m.type === "match");
  check("buyer gets match notification", !!mBuyer, JSON.stringify(buyer.msgs.slice(-3)));
  check("seller gets match notification", !!mSeller);
  check(
    "match describes overlap + other party",
    !!mBuyer &&
      mBuyer.overlap.includes(T("vintage-cameras")) &&
      mBuyer.other.name === "SellerMuse" &&
      mBuyer.other.kind === "offer"
  );
  const dealRoom = mBuyer && mBuyer.room_id;
  check("deal room id looks right", typeof dealRoom === "string" && /^deal-\d+$/.test(dealRoom || ""), dealRoom);
  const invBuyer = buyer.msgs.find((m) => m.type === "invited" && m.room_id === dealRoom);
  const invSeller = seller.msgs.find((m) => m.type === "invited" && m.room_id === dealRoom);
  check("both parties invited to the deal room", !!invBuyer && !!invSeller);

  // both can actually join the private deal room…
  buyer.ws.send(JSON.stringify({ type: "hello", name: "BuyerMuse", room: dealRoom }));
  const inDeal = await waitFor(buyer, (m) => m.type === "state" && m.room_id === dealRoom);
  check("invited buyer can join the deal room", !!inDeal);
  // …but a stranger cannot
  const stranger = await openAgent("StrangerMuse");
  stranger.ws.send(JSON.stringify({ type: "hello", name: "StrangerMuse", room: dealRoom }));
  const denied = await waitFor(stranger, (m) => m.type === "error" && /invite-only/.test(m.message || ""));
  check("stranger denied from private deal room", !!denied);

  // 3. non-overlapping post -> no match for anyone
  const before = seller.msgs.filter((m) => m.type === "match").length;
  const other = await openAgent("OtherMuse");
  other.ws.send(
    JSON.stringify({
      type: "post",
      kind: "want",
      topics: [T("unrelated-topic")],
      title: "Want a toaster",
    })
  );
  await new Promise((r) => setTimeout(r, 1200));
  const after = seller.msgs.filter((m) => m.type === "match").length;
  check("non-overlapping post triggers no match", after === before, `matches ${before} -> ${after}`);

  // 4. validation: bad kind / missing title / no topics
  other.ws.send(JSON.stringify({ type: "post", kind: "maybe", topics: [T("x")], title: "bad kind" }));
  const e1 = await waitFor(other, (m) => m.type === "error" && /kind must be/.test(m.message || ""));
  check("bad kind rejected", !!e1);
  other.ws.send(JSON.stringify({ type: "post", kind: "want", topics: [T("x")] }));
  const e2 = await waitFor(other, (m) => m.type === "error" && /title is required/.test(m.message || ""));
  check("missing title rejected", !!e2);
  other.ws.send(JSON.stringify({ type: "post", kind: "want", topics: [], title: "no topics" }));
  const e3 = await waitFor(other, (m) => m.type === "error" && /at least one topic/.test(m.message || ""));
  check("post without topics rejected", !!e3);

  // 5. close_post: only the poster can close
  other.ws.send(JSON.stringify({ type: "close_post", id: listed.id }));
  const e4 = await waitFor(other, (m) => m.type === "error" && /only the poster/.test(m.message || ""));
  check("non-poster cannot close", !!e4);
  seller.ws.send(JSON.stringify({ type: "close_post", id: listed.id }));
  const closed = await waitFor(seller, (m) => m.type === "post_closed" && m.id === listed.id);
  check("poster can close", !!closed);
  const board2 = JSON.parse((await getJson("/api/board")).body);
  check("closed post leaves /api/board", !(board2.posts || []).some((p) => p.id === listed.id));

  // 6. /board page loads
  const page = await getJson("/board");
  check("/board page loads", page.status === 200 && page.body.includes("Intent board"));

  console.log("host-muse role");
  // 7. verified host (HOST_MUSE env names the manifest's verified name)
  // admits a knocker to someone else's room. A bare display-name claim
  // does NOT grant host authority (PR #2).
  const host = await openVerifiedAgent("HostMuse", HOST_MANIFEST_URL);
  const creator = await openAgent("RoomCreator");
  creator.ws.send(JSON.stringify({ type: "create_room", topic: "host-test-room", entry: "knock" }));
  const created = await waitFor(creator, (m) => m.type === "room_created");
  const roomId = created.room_id;
  const guest = await openAgent("GuestOne");
  guest.ws.send(JSON.stringify({ type: "hello", name: "GuestOne", room: roomId }));
  const knockReq = await waitFor(host, (m) => m.type === "knock_request" && m.room_id === roomId);
  check("host sees knock requests on others' rooms", !!knockReq);
  // PR #2: session ids are server-minted and random — admit with the real
  // id from the knock request, never a derived one.
  const guestId = knockReq && knockReq.agent && knockReq.agent.id;
  host.ws.send(JSON.stringify({ type: "admit", room_id: roomId, agent: guestId }));
  const admitted = await waitFor(guest, (m) => m.type === "admitted" && m.room_id === roomId);
  check("host can admit to a room they did not create", !!admitted);

  // 8. host rejects; non-host cannot admit
  const guest2 = await openAgent("GuestTwo");
  guest2.ws.send(JSON.stringify({ type: "hello", name: "GuestTwo", room: roomId }));
  const knockReq2 = await waitFor(host, (m) => m.type === "knock_request" && m.agent && m.agent.name === "GuestTwo");
  const guest2Id = knockReq2 && knockReq2.agent && knockReq2.agent.id;
  const regular = await openAgent("RegularMuse");
  regular.ws.send(JSON.stringify({ type: "admit", room_id: roomId, agent: guest2Id }));
  const e5 = await waitFor(regular, (m) => m.type === "error" && /creator or host/.test(m.message || ""));
  check("non-host cannot admit", !!e5);
  host.ws.send(JSON.stringify({ type: "reject", room_id: roomId, agent: guest2Id }));
  const rejected = await waitFor(guest2, (m) => m.type === "rejected" && m.room_id === roomId);
  check("host can reject a knocker", !!rejected);

  // 9. announce: verified host ok (moderate scope is granted to the host
  // identity), non-host denied with a structured scope error
  host.ws.send(JSON.stringify({ type: "announce", text: "test announcement" }));
  const announced = await waitFor(
    regular,
    (m) => m.type === "state" && m.agents && m.agents.some((a) => (a.bubble || "").includes("test announcement")),
    8000
  );
  check("host announce succeeds", !!announced);
  regular.ws.send(JSON.stringify({ type: "announce", text: "i should not be allowed" }));
  const e6 = await waitFor(regular, (m) => m.type === "error" && m.code === "INSUFFICIENT_SCOPE");
  check("non-host announce denied", !!e6, JSON.stringify(regular.msgs.slice(-2)));

  // 10. marketplace room exists and is public
  const viewer = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const plazaState = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    viewer.on("open", () => viewer.send(JSON.stringify({ type: "hello", kind: "viewer", room: "plaza" })));
    viewer.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === "state" && m.room_id === "plaza") {
        clearTimeout(timer);
        resolve(m);
      }
    });
  });
  const mp = plazaState && plazaState.rooms.find((r) => r.room_id === "marketplace");
  check("#marketplace listed as public room", !!(mp && mp.visibility === "public"));

  for (const r of [seller, buyer, stranger, other, host, creator, guest, guest2, regular]) r.ws.close();
  viewer.close();
  server.kill();
  hostFixture.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
