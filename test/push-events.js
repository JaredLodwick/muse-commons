// Push social events tests (roadmap PR #7): discrete server-pushed
// events over the existing WebSocket — message, mention, reply,
// presence, invite, match — with per-room subscriptions, a resume cursor
// (last_seq), gap-too-old resync, block suppression, and private-room
// isolation. No polling involved.
//
// Spawns a real lobby server child with a small event buffer.
//   node test/push-events.js
// Exit 0 = all pass, 1 = any failure.
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT = 18791;

const RUN = Math.random().toString(36).slice(2, 8);
const T = (s) => `${s}-${RUN}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : " " + ""}`);
  }
}

function startLobby() {
  return spawn("node", [LOBBY], {
    env: {
      ALLOW_UNVERIFIED: "1",
      ...process.env,
      PORT: String(PORT),
      HEARTBEAT_TIMEOUT_MS: "60000", // no expiry churn during the test
      EVENT_BUFFER: "10", // small buffer so the resync test stays fast
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens an agent and collects every inbound message. Resolves on hello_ok.
function openAgent(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rec = {
      ws,
      name,
      token: null,
      agentId: null,
      all: [], // every inbound message
      events: [], // inbound {type:"event"} only
      send(obj) {
        ws.send(JSON.stringify(rec.token ? { session_token: rec.token, ...obj } : obj));
      },
      close() {
        try { ws.close(); } catch {}
      },
    };
    const timer = setTimeout(() => reject(new Error(`hello timeout for ${name}`)), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, protocol_version: "1.0", ...extra })));
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      rec.all.push(m);
      if (m.type === "event") rec.events.push(m);
      if (m.type === "hello_ok") {
        clearTimeout(timer);
        rec.token = m.session_token || null;
        rec.agentId = m.agent_id || null;
        resolve(rec);
      }
      if (m.type === "error" && !rec.token) {
        clearTimeout(timer);
        reject(new Error(`hello failed for ${name}: ${m.code} ${m.message}`));
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// Wait for an event matching pred, or null on timeout.
function waitEvent(rec, pred, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = rec.events.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => { rec.ws.off("message", onMsg); resolve(null); }, timeoutMs);
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "event" && pred(m)) {
        clearTimeout(timer);
        rec.ws.off("message", onMsg);
        resolve(m);
      }
    };
    rec.ws.on("message", onMsg);
  });
}

function eventShapeOk(ev, roomId) {
  return (
    ev && ev.type === "event" &&
    typeof ev.ev_id === "string" && ev.ev_id.startsWith("e-") &&
    typeof ev.seq === "number" && ev.seq > 0 &&
    typeof ev.t === "number" && ev.t > 0 &&
    ev.room_id === roomId
  );
}

async function main() {
  const server = startLobby();
  try {
    await waitForListening(server);

    // --- 1. message events arrive without polling -----------------------
    const alice = await openAgent(T("alice"));
    const bob = await openAgent(T("bob"));
    const carol = await openAgent(T("carol"));
    alice.send({ type: "say", text: "hello plaza" });
    const msgEv = await waitEvent(bob, (e) => e.event === "message" && e.text === "hello plaza");
    check("message event pushed to room subscriber", !!msgEv, msgEv ? "" : "no event arrived");
    check("message event shape (ev_id/seq/t/room_id)", eventShapeOk(msgEv, "plaza"));

    // --- 2. reply events for directed speech -----------------------------
    alice.send({ type: "talk", to: bob.name, text: "hey bob, over here" });
    const replyEv = await waitEvent(bob, (e) => e.event === "reply" && e.text === "hey bob, over here");
    check("reply event pushed on talk", !!replyEv && replyEv.to === bob.name && replyEv.from === alice.name);

    // --- 3. mention events are targeted ----------------------------------
    alice.send({ type: "say", text: `ping @${bob.name} are you there` });
    const mentionEv = await waitEvent(bob, (e) => e.event === "mention" && e.to === bob.name);
    check("mention event pushed to the named agent", !!mentionEv && mentionEv.from === alice.name);
    await sleep(600);
    const carolMentions = carol.events.filter((e) => e.event === "mention");
    check("mention event not delivered to other agents", carolMentions.length === 0, `carol saw ${carolMentions.length}`);
    const carolGotMessage = carol.events.some((e) => e.event === "message" && e.text === `ping @${bob.name} are you there`);
    check("plain message event still reaches everyone", carolGotMessage);

    // --- 4. presence events on join/leave --------------------------------
    const dave = await openAgent(T("dave"));
    const joinEv = await waitEvent(bob, (e) => e.event === "presence" && e.presence === "join" && e.name === dave.name);
    check("presence join event pushed", !!joinEv);
    // dave moves to another room -> leave event in plaza
    dave.ws.send(JSON.stringify({ type: "hello", name: dave.name, room: "tech", protocol_version: "1.0" }));
    const leaveEv = await waitEvent(bob, (e) => e.event === "presence" && e.presence === "leave" && e.name === dave.name);
    check("presence leave event pushed", !!leaveEv);

    // --- 5. subscribe narrows the stream ---------------------------------
    bob.send({ type: "subscribe", events: ["mention"] });
    const subbed = await new Promise((resolve) => {
      const prior = bob.all.find((m) => m.type === "subscribed");
      if (prior) return resolve(prior);
      const t = setTimeout(() => resolve(null), 3000);
      const onMsg = (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === "subscribed") { clearTimeout(t); bob.ws.off("message", onMsg); resolve(m); }
      };
      bob.ws.on("message", onMsg);
    });
    check("subscribed receipt with current_seq", !!subbed && typeof subbed.current_seq === "number" && subbed.room_id === "plaza");
    const seqBefore = subbed.current_seq;
    alice.send({ type: "say", text: "this should not reach bob" });
    await sleep(600);
    const bobSawPlain = bob.events.some((e) => e.seq > seqBefore && e.event === "message");
    check("unsubscribed kind is suppressed", !bobSawPlain);
    alice.send({ type: "say", text: `still here @${bob.name}` });
    const mentionAfter = await waitEvent(bob, (e) => e.event === "mention" && e.seq > seqBefore);
    check("subscribed kind still arrives", !!mentionAfter);
    // restore the default subscription for later tests
    bob.send({ type: "subscribe", events: ["message", "mention", "reply", "presence", "invite", "match"] });
    await sleep(300);

    // --- 6. invite events --------------------------------------------------
    alice.send({ type: "create_room", topic: "secret club", visibility: "private", entry: "invite" });
    const created = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      const onMsg = (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === "room_created") { clearTimeout(t); alice.ws.off("message", onMsg); resolve(m); }
      };
      alice.ws.on("message", onMsg);
    });
    check("private room created", !!created && created.visibility === "private");
    const privRoom = created.room_id;
    alice.send({ type: "invite", room_id: privRoom, to: bob.name });
    const inviteEv = await waitEvent(bob, (e) => e.event === "invite" && e.room_id === privRoom);
    check("invite event pushed to invitee (follows across rooms)", !!inviteEv && inviteEv.to === bob.name);

    // --- 7. private-room events stay with participants ---------------------
    bob.ws.send(JSON.stringify({ type: "hello", name: bob.name, room: privRoom, protocol_version: "1.0" }));
    await sleep(500);
    alice.send({ type: "say", text: "private hello" });
    const bobPriv = await waitEvent(bob, (e) => e.event === "message" && e.text === "private hello" && e.room_id === privRoom);
    check("private message event reaches participant", !!bobPriv && bobPriv.visibility === "private");
    await sleep(600);
    const carolPriv = carol.events.filter((e) => e.room_id === privRoom);
    check("private events never leak to non-participants", carolPriv.length === 0, `carol saw ${carolPriv.length}`);
    carol.send({ type: "subscribe", room_id: privRoom });
    const subErr = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 2000);
      const onMsg = (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === "error" && m.code === "NO_SUCH_ROOM") { clearTimeout(t); carol.ws.off("message", onMsg); resolve(m); }
      };
      carol.ws.on("message", onMsg);
    });
    check("subscribing to a private room from outside is refused", !!subErr);

    // --- 8. resume cursor: reconnect replays exactly the missed events ----
    // alice is still in the private room; bring everyone back to plaza.
    alice.ws.send(JSON.stringify({ type: "hello", name: alice.name, room: "plaza", protocol_version: "1.0" }));
    bob.ws.send(JSON.stringify({ type: "hello", name: bob.name, room: "plaza", protocol_version: "1.0" }));
    await sleep(500);
    const plazaMax = (rec) => Math.max(0, ...rec.events.filter((e) => e.room_id === "plaza").map((e) => e.seq));
    const cursor = plazaMax(bob);
    bob.close();
    await sleep(400); // let the socket die fully
    const missed = ["missed one", "missed two", "missed three"];
    for (const text of missed) {
      alice.send({ type: "say", text });
      await sleep(150);
    }
    const bob2 = await openAgent(bob.name, { room: "plaza", last_seq: cursor });
    const replayed = [];
    for (const text of missed) {
      const ev = await waitEvent(bob2, (e) => e.event === "message" && e.text === text, 4000);
      if (ev) replayed.push(ev);
    }
    check("resume replays exactly the missed messages", replayed.length === missed.length,
      `got ${replayed.length}/${missed.length}`);
    check("replayed events are ordered by seq",
      replayed.every((e, i) => i === 0 || e.seq > replayed[i - 1].seq) &&
      replayed.every((e) => e.seq > cursor));
    check("no duplicate replays", new Set(replayed.map((e) => e.seq)).size === replayed.length);
    // a fresh cursor replays nothing stale. Delivery is at-least-once:
    // erin's own join is a genuinely new event (seq > freshSeq) and may
    // arrive both live and in the replay; the client dedupes by seq.
    const freshSeq = plazaMax(bob2);
    const bob3 = await openAgent(T("erin"), { room: "plaza", last_seq: freshSeq });
    await sleep(800);
    const erinStale = bob3.events.filter((e) => e.seq <= freshSeq);
    const erinOther = bob3.events.filter(
      (e) => !(e.event === "presence" && e.presence === "join" && e.name === bob3.name)
    );
    check("up-to-date cursor replays nothing stale",
      erinStale.length === 0 && erinOther.length === 0 && bob3.events.length <= 2,
      `stale=${erinStale.length} other=${erinOther.length} total=${bob3.events.length}`);

    // --- 9. cursor too old -> resync ---------------------------------------
    // buffer is 10; push 14 fresh events so last_seq falls off it.
    for (let i = 0; i < 14; i++) {
      alice.send({ type: "say", text: `flood ${i}` });
      await sleep(60);
    }
    await sleep(400);
    const stale = await openAgent(T("frank"), { room: "plaza", last_seq: cursor });
    const resync = await new Promise((resolve) => {
      const prior = stale.all.find((m) => m.type === "resync");
      if (prior) return resolve(prior);
      const t = setTimeout(() => resolve(null), 4000);
      const onMsg = (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === "resync") { clearTimeout(t); stale.ws.off("message", onMsg); resolve(m); }
      };
      stale.ws.on("message", onMsg);
    });
    check("stale cursor gets resync instead of replay", !!resync && resync.reason === "cursor_too_old");
    check("resync carries a fresh baseline", !!resync && Array.isArray(resync.events) &&
      resync.events.length > 0 && typeof resync.current_seq === "number" &&
      resync.events.every((e) => e.type === "event"));
    const staleReplays = stale.events.filter((e) => e.seq <= cursor);
    check("no ancient events replayed on resync", staleReplays.length === 0);

    // --- 10. blocked agents' events are suppressed -------------------------
    // (carol speaks here: alice just burned her say quota on the flood test)
    const gail = await openAgent(T("gail"));
    const hank = await openAgent(T("hank"));
    gail.send({ type: "block", agent: hank.name });
    await sleep(400);
    const gailMark = Math.max(...gail.events.map((e) => e.seq), 0);
    hank.send({ type: "say", text: "you cannot hear me" });
    carol.send({ type: "say", text: "but you can hear carol" });
    await sleep(800);
    const gailNew = gail.events.filter((e) => e.seq > gailMark);
    check("blocked agent's message event suppressed",
      !gailNew.some((e) => e.from === hank.name), `gail saw: ${gailNew.map((e) => e.from).join(",")}`);
    check("other agents' events still arrive",
      gailNew.some((e) => e.event === "message" && e.from === carol.name && e.text === "but you can hear carol"));

    // --- 11. seq is monotonic per room --------------------------------------
    const plazaSeqs = alice.events.filter((e) => e.room_id === "plaza").map((e) => e.seq);
    check("seq strictly increases per room",
      plazaSeqs.every((s, i) => i === 0 || s > plazaSeqs[i - 1]) && plazaSeqs.length > 5);

    for (const r of [alice, bob2, bob3, carol, dave, gail, hank, stale]) r.close();
  } finally {
    server.kill("SIGTERM");
  }
}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nall push-event tests passed");
    process.exit(failures ? 1 : 0);
  },
  (e) => {
    console.error("test harness error:", e);
    process.exit(1);
  }
);
