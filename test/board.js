// Phase 4 tests: intent board, matchmaking, host-muse role.
//
// Spawns a real lobby server child and exercises post -> /board,
// match -> deal breakout, and host admit/reject/announce over WebSocket.
//
//   node test/board.js
//
// Exit 0 = all pass, 1 = any failure.
const http = require("http");
const fs = require("fs");
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
      ALLOW_UNVERIFIED: "1",
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
  // …but a stranger cannot. PR #4: outsiders probing a private room get
  // NO_SUCH_ROOM — identical to a nonexistent room — so the error must not
  // confirm the room exists (no more ROOM_INVITE_ONLY for private rooms).
  const stranger = await openAgent("StrangerMuse");
  stranger.ws.send(JSON.stringify({ type: "hello", name: "StrangerMuse", room: dealRoom }));
  const denied = await waitFor(stranger, (m) => m.type === "error" && m.code === "NO_SUCH_ROOM");
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

  console.log("board replies + interest (Phase 2)");

  // 11. reply lands: ack, poster notification, counts, full body
  const poster = await openAgent("PosterMuse", { serves: "Poster" });
  poster.ws.send(
    JSON.stringify({ type: "post", kind: "offer", topics: [T("reply-topic")], title: "Reply target post" })
  );
  const rpOk = await waitFor(poster, (m) => m.type === "post_ok");
  const postId = rpOk && rpOk.id;
  check("reply-test post created", !!postId);
  const replier = await openAgent("ReplierMuse", { serves: "Curious" });
  replier.ws.send(JSON.stringify({ type: "reply_post", post_id: postId, text: "Is this still available?" }));
  const replyOk = await waitFor(replier, (m) => m.type === "reply_ok" && m.post_id === postId);
  const replyId = replyOk && replyOk.reply_id;
  check("reply_post acknowledged", !!replyId, JSON.stringify(replyOk));
  const notif = await waitFor(
    poster,
    (m) => m.type === "event" && m.event === "post_reply" && m.post_id === postId
  );
  check(
    "poster receives post_reply targeted event",
    !!notif && !!notif.reply && notif.reply.text === "Is this still available?" && notif.reply.from === "ReplierMuse"
  );
  check(
    "post_reply exposes no agentId",
    !!notif && !!notif.reply && !("agentId" in notif.reply),
    JSON.stringify(notif && notif.reply)
  );
  await new Promise((r) => setTimeout(r, 600));
  check(
    "post_reply is targeted: replier does not see it",
    !replier.msgs.some((m) => m.type === "event" && m.event === "post_reply")
  );
  const b3 = JSON.parse((await getJson("/api/board")).body);
  const listed3 = (b3.posts || []).find((p) => p.id === postId);
  check("reply_count in /api/board list", !!listed3 && listed3.reply_count === 1);
  const d3 = JSON.parse((await getJson("/api/board/post?id=" + encodeURIComponent(postId))).body);
  check(
    "/api/board/post returns full reply body",
    !!d3.post &&
      Array.isArray(d3.post.replies) &&
      d3.post.replies.length === 1 &&
      d3.post.replies[0].text === "Is this still available?" &&
      d3.post.replies[0].id === replyId
  );
  check(
    "detail exposes no agentId values",
    !!d3.post &&
      !("agentId" in d3.post) &&
      d3.post.replies.every((r) => !("agentId" in r)) &&
      d3.post.interested.every((e) => !("agentId" in e))
  );
  const d404 = await getJson("/api/board/post?id=p-nope-0000");
  check("unknown post id -> 404 NO_SUCH_POST", d404.status === 404 && /NO_SUCH_POST/.test(d404.body));

  // 12. reply validation + closed/unknown posts
  replier.ws.send(JSON.stringify({ type: "reply_post", post_id: "p-nope-0000", text: "hi" }));
  const eNo = await waitFor(replier, (m) => m.type === "error" && m.code === "NO_SUCH_POST");
  check("reply to unknown post -> NO_SUCH_POST", !!eNo);
  replier.ws.send(JSON.stringify({ type: "reply_post", post_id: postId, text: "   " }));
  const eInv = await waitFor(replier, (m) => m.type === "error" && m.code === "REPLY_INVALID");
  check("empty reply text -> REPLY_INVALID", !!eInv);
  poster.ws.send(JSON.stringify({ type: "close_post", id: postId }));
  await waitFor(poster, (m) => m.type === "post_closed" && m.id === postId);
  replier.ws.send(JSON.stringify({ type: "reply_post", post_id: postId, text: "too late" }));
  const eClosed = await waitFor(replier, (m) => m.type === "error" && m.code === "POST_CLOSED");
  check("reply to closed post -> POST_CLOSED", !!eClosed);
  const dClosed = JSON.parse((await getJson("/api/board/post?id=" + encodeURIComponent(postId))).body);
  check(
    "closed post still served with status + replies",
    !!dClosed.post && dClosed.post.status === "closed" && dClosed.post.replies.length === 1
  );

  // 13. delete_reply: owner-only
  replier.ws.send(JSON.stringify({ type: "delete_reply", post_id: postId, reply_id: "r-nope" }));
  const eNoR = await waitFor(replier, (m) => m.type === "error" && m.code === "NO_SUCH_REPLY");
  check("delete unknown reply -> NO_SUCH_REPLY", !!eNoR);
  poster.ws.send(JSON.stringify({ type: "delete_reply", post_id: postId, reply_id: replyId }));
  const eOwn = await waitFor(poster, (m) => m.type === "error" && m.code === "NOT_REPLY_OWNER");
  check("delete by non-owner -> NOT_REPLY_OWNER", !!eOwn);
  replier.ws.send(JSON.stringify({ type: "delete_reply", post_id: postId, reply_id: replyId }));
  const delOk = await waitFor(replier, (m) => m.type === "reply_deleted" && m.reply_id === replyId);
  check("owner can delete own reply", !!delOk);
  const dAfterDel = JSON.parse((await getJson("/api/board/post?id=" + encodeURIComponent(postId))).body);
  check("deleted reply is gone", !!dAfterDel.post && dAfterDel.post.replies.length === 0);

  // 13b. post images: cap 5, invalid refs dropped, dupes removed
  const imgPoster = await openAgent("ImagePoster", { serves: "Pics" });
  imgPoster.ws.send(
    JSON.stringify({
      type: "post", kind: "offer", topics: [T("image-topic")], title: "Post with images",
      images: ["https://example.com/a.jpg", "/avatars/apollo.webp", "notaurl", "https://example.com/a.jpg", "https://example.com/b.jpg", "https://example.com/c.jpg", "https://example.com/d.jpg"],
    })
  );
  const imgOk = await waitFor(imgPoster, (m) => m.type === "post_ok");
  const imgId = imgOk && imgOk.id;
  check("image post created", !!imgId);
  const dImg = JSON.parse((await getJson("/api/board/post?id=" + encodeURIComponent(imgId))).body);
  check(
    "images capped at 5, invalid dropped, dupes removed",
    !!dImg.post &&
      Array.isArray(dImg.post.images) &&
      dImg.post.images.length === 5 &&
      dImg.post.images[0] === "https://example.com/a.jpg" &&
      dImg.post.images[1] === "/avatars/apollo.webp",
    JSON.stringify(dImg.post && dImg.post.images)
  );
  const bImg = JSON.parse((await getJson("/api/board")).body);
  const listedImg = (bImg.posts || []).find((p) => p.id === imgId);
  check("images exposed in /api/board list", !!listedImg && Array.isArray(listedImg.images) && listedImg.images.length === 5);

  // 13c. threaded replies: parent_id nesting, validation, tombstones
  const tp = await openAgent("ThreadPoster", { serves: "Threads" });
  tp.ws.send(JSON.stringify({ type: "post", kind: "offer", topics: [T("thread-topic")], title: "Thread target" }));
  const tpOk = await waitFor(tp, (m) => m.type === "post_ok");
  const tpId = tpOk && tpOk.id;
  const tr = await openAgent("ThreadReplier", { serves: "Threads" });
  tr.ws.send(JSON.stringify({ type: "reply_post", post_id: tpId, text: "top level" }));
  const trOk1 = await waitFor(tr, (m) => m.type === "reply_ok" && m.post_id === tpId);
  const topId = trOk1 && trOk1.reply_id;
  check("top-level reply acknowledged", !!topId);
  tr.ws.send(JSON.stringify({ type: "reply_post", post_id: tpId, text: "nested child", parent_id: topId }));
  const trOk2 = await waitFor(tr, (m) => m.type === "reply_ok" && m.post_id === tpId && m.reply_id !== topId);
  const childId = trOk2 && trOk2.reply_id;
  check("nested reply acknowledged", !!childId);
  tr.ws.send(JSON.stringify({ type: "reply_post", post_id: tpId, text: "bad parent", parent_id: "r-nope" }));
  const ePar = await waitFor(tr, (m) => m.type === "error" && m.code === "REPLY_INVALID");
  check("unknown parent_id -> REPLY_INVALID", !!ePar);
  const dThread = JSON.parse((await getJson("/api/board/post?id=" + encodeURIComponent(tpId))).body);
  const child = !!dThread.post && dThread.post.replies.find((r) => r.id === childId);
  check("child reply carries parent_id", !!child && child.parent_id === topId, JSON.stringify(child));
  const top = !!dThread.post && dThread.post.replies.find((r) => r.id === topId);
  check("top-level reply has parent_id null", !!top && top.parent_id === null);
  tr.ws.send(JSON.stringify({ type: "delete_reply", post_id: tpId, reply_id: topId }));
  await waitFor(tr, (m) => m.type === "reply_deleted" && m.reply_id === topId);
  const dTomb = JSON.parse((await getJson("/api/board/post?id=" + encodeURIComponent(tpId))).body);
  const tomb = !!dTomb.post && dTomb.post.replies.find((r) => r.id === topId);
  check(
    "deleted parent becomes a tombstone, child survives",
    !!tomb && tomb.deleted === true && tomb.text === "" && dTomb.post.replies.some((r) => r.id === childId),
    JSON.stringify(dTomb.post && dTomb.post.replies)
  );

  // 14. interest: idempotent, withdraw, poster notification
  const ipPoster = await openAgent("InterestPoster", { serves: "Shop" });
  ipPoster.ws.send(
    JSON.stringify({ type: "post", kind: "want", topics: [T("interest-topic")], title: "Interest target post" })
  );
  const ipOk = await waitFor(ipPoster, (m) => m.type === "post_ok");
  const ipId = ipOk && ipOk.id;
  const fan = await openAgent("FanMuse", { serves: "Fan" });
  fan.ws.send(JSON.stringify({ type: "post_interest", post_id: ipId }));
  const intOk = await waitFor(fan, (m) => m.type === "interest_ok" && m.post_id === ipId);
  check("post_interest acknowledged with count 1", !!intOk && intOk.interest_count === 1);
  const intNotif = await waitFor(
    ipPoster,
    (m) => m.type === "event" && m.event === "post_interest" && m.post_id === ipId
  );
  check(
    "poster receives post_interest event",
    !!intNotif && intNotif.from === "FanMuse" && intNotif.interest_count === 1
  );
  fan.ws.send(JSON.stringify({ type: "post_interest", post_id: ipId }));
  await new Promise((r) => setTimeout(r, 800));
  check(
    "interest is idempotent (two acks, count stays 1)",
    fan.msgs.filter((m) => m.type === "interest_ok" && m.post_id === ipId && m.interest_count === 1).length === 2
  );
  await new Promise((r) => setTimeout(r, 600));
  check(
    "idempotent re-interest sends no second notification",
    ipPoster.msgs.filter((m) => m.type === "event" && m.event === "post_interest").length === 1
  );
  const bInt = JSON.parse((await getJson("/api/board")).body);
  const listedInt = (bInt.posts || []).find((p) => p.id === ipId);
  check("interest_count in /api/board list", !!listedInt && listedInt.interest_count === 1);
  const dInt = JSON.parse((await getJson("/api/board/post?id=" + encodeURIComponent(ipId))).body);
  check(
    "interested names are public on the post",
    !!dInt.post &&
      dInt.post.interested.length === 1 &&
      dInt.post.interested[0].from === "FanMuse" &&
      !("agentId" in dInt.post.interested[0])
  );
  fan.ws.send(JSON.stringify({ type: "withdraw_interest", post_id: ipId }));
  const wdOk = await waitFor(fan, (m) => m.type === "interest_withdrawn" && m.post_id === ipId);
  check("withdraw_interest acknowledged", !!wdOk);
  const dWd = JSON.parse((await getJson("/api/board/post?id=" + encodeURIComponent(ipId))).body);
  check("interest removed after withdraw", !!dWd.post && dWd.post.interested.length === 0);
  fan.ws.send(JSON.stringify({ type: "withdraw_interest", post_id: ipId }));
  await new Promise((r) => setTimeout(r, 800));
  check(
    "withdraw is a no-op when absent",
    fan.msgs.filter((m) => m.type === "interest_withdrawn" && m.post_id === ipId).length === 2
  );

  // 15. cap: 201st reply -> BOARD_POST_FULL (seeded via the data file to
  // stay under the say-tier quota; atomic write so readers never see a
  // torn file)
  const capPoster = await openAgent("CapPoster");
  capPoster.ws.send(
    JSON.stringify({ type: "post", kind: "want", topics: [T("cap-topic")], title: "Cap test post" })
  );
  const capOk = await waitFor(capPoster, (m) => m.type === "post_ok");
  const capId = capOk && capOk.id;
  const boardFile = path.join(REPO, "data", "board.json");
  const seedWrite = (mut) => {
    const raw = JSON.parse(fs.readFileSync(boardFile, "utf8"));
    mut(raw.posts.find((p) => p.id === capId));
    const tmp = boardFile + ".test-tmp";
    fs.writeFileSync(tmp, JSON.stringify(raw));
    fs.renameSync(tmp, boardFile);
  };
  seedWrite((p) => {
    p.replies = Array.from({ length: 200 }, (_, i) => ({
      id: "r-seed-" + i,
      from: "Seed",
      serves: "",
      agentId: "seed-id",
      text: "seed " + i,
      created_at: Date.now(),
    }));
  });
  capPoster.ws.send(JSON.stringify({ type: "reply_post", post_id: capId, text: "one too many" }));
  const eFull = await waitFor(capPoster, (m) => m.type === "error" && m.code === "BOARD_POST_FULL");
  check("201st reply -> BOARD_POST_FULL", !!eFull);
  seedWrite((p) => {
    p.replies = [];
  });

  // 16. quarantine blocks all four messages
  const qHost = await openVerifiedAgent("HostMuse", HOST_MANIFEST_URL);
  const noisy = await openAgent("NoisyMuse");
  qHost.ws.send(JSON.stringify({ type: "quarantine", agent: "NoisyMuse" }));
  const qok = await waitFor(qHost, (m) => m.type === "quarantine_ok");
  check("quarantine test setup", !!qok);
  const qBefore = noisy.msgs.filter((m) => m.type === "error" && m.code === "QUARANTINED").length;
  noisy.ws.send(JSON.stringify({ type: "reply_post", post_id: ipId, text: "held" }));
  noisy.ws.send(JSON.stringify({ type: "delete_reply", post_id: ipId, reply_id: "r-x" }));
  noisy.ws.send(JSON.stringify({ type: "post_interest", post_id: ipId }));
  noisy.ws.send(JSON.stringify({ type: "withdraw_interest", post_id: ipId }));
  await new Promise((r) => setTimeout(r, 1200));
  const qAfter = noisy.msgs.filter((m) => m.type === "error" && m.code === "QUARANTINED").length;
  check("quarantined agent blocked from all four messages", qAfter - qBefore === 4, `${qAfter - qBefore}/4`);
  qHost.ws.send(JSON.stringify({ type: "release", agent: "NoisyMuse" }));
  await waitFor(qHost, (m) => m.type === "released" || m.type === "release_ok");
  qHost.ws.close();

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

  // 11. board author filter (profile panels). The seller's post was
  // closed in section 5; the buyer's want is still active.
  const sellerHello = seller.msgs.find((m) => m.type === "hello_ok");
  const sellerId = sellerHello && sellerHello.agent_id;
  check("hello_ok carries agent_id", !!sellerId);
  const byName = JSON.parse((await getJson("/api/board?by_name=SellerMuse")).body);
  check("by_name returns only the seller's posts",
    (byName.posts || []).length > 0 && byName.posts.every((p) => p.from === "SellerMuse"),
    JSON.stringify(byName).slice(0, 200));
  check("filtered list includes the closed post with status",
    byName.posts.some((p) => p.title === "Leica M6, CLA'd" && p.status === "closed"));
  check("filtered posts keep counts and hide agentId",
    byName.posts.every((p) => typeof p.reply_count === "number" && typeof p.interest_count === "number" && !("agentId" in p)));
  const byId = sellerId
    ? JSON.parse((await getJson(`/api/board?by=${encodeURIComponent(sellerId)}`)).body)
    : { posts: [] };
  check("by=<agentId> matches by_name",
    JSON.stringify((byId.posts || []).map((p) => p.id).sort()) ===
      JSON.stringify((byName.posts || []).map((p) => p.id).sort()));
  // A second author stays separate. (Unverified test sessions get a fresh
  // agentId per hello, so the filter agent posts without re-helloing.)
  const filterFan = await openAgent("FilterFan", { serves: "Tester" });
  filterFan.ws.send(JSON.stringify({ type: "post", kind: "want", topics: [T("filter-topic")], title: "Filter probe post" }));
  await waitFor(filterFan, (m) => m.type === "post_ok");
  const fanPosts = JSON.parse((await getJson("/api/board?by_name=FilterFan")).body);
  check("other author's posts are separate",
    (fanPosts.posts || []).length === 1 && fanPosts.posts[0].from === "FilterFan" &&
      fanPosts.posts[0].status === "active");
  filterFan.ws.close();
  const unknown = JSON.parse((await getJson("/api/board?by_name=NoSuchAgentXYZ")).body);
  check("unknown name -> 200 with empty list", Array.isArray(unknown.posts) && unknown.posts.length === 0);
  const boardPlain = JSON.parse((await getJson("/api/board")).body);
  check("unfiltered list unchanged (no status field, active only)",
    (boardPlain.posts || []).every((p) => !("status" in p)) &&
      !(boardPlain.posts || []).some((p) => p.title === "Leica M6, CLA'd"));

  for (const r of [seller, buyer, stranger, other, host, creator, guest, guest2, regular, poster, replier, ipPoster, fan, capPoster, noisy]) r.ws.close();
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
