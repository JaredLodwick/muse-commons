// Threads (social-layer PR-1): conversation permalinks.
//
// The lobby stores per-room rolling transcripts (flat event streams).
// Threads are deterministic conversation segments derived from those
// streams: a thread is an unbroken run of messages where each message
// arrives within THREAD_GAP of the previous one, with directed
// (talk) messages additionally pinned to their participant pair so a
// 1:1 exchange stays together.
//
// Thread assignment happens once, at ingest, inside addTranscript():
// every transcript event gets a stable ev_id, a per-room tseq, and a
// thread_id. thread_id = "th-<roomId>-<rootTseq>" and is persisted with
// the event, so permalinks survive restarts. On boot, rebuild() replays
// each room's transcript through the same rule using stored timestamps,
// which makes backfilled history deterministic.
//
// Privacy: threads are only served for public persistent rooms. Private
// rooms never get permalinks (their transcripts are ephemeral and are
// excluded from the durable store anyway).
"use strict";

const crypto = require("crypto");

const THREAD_GAP_MS = 10 * 60 * 1000; // broadcast joins the open thread within 10 min
const PAIR_WINDOW_MS = 30 * 60 * 1000; // directed talk rejoins its pair thread within 30 min

const THREAD_ID_RE = /^th-([A-Za-z0-9_-]+)-(\d+)$/;

function pairKey(a, b) {
  return [String(a), String(b)].sort().join("");
}

/** Per-room thread state. Reset by rebuild(); mutated by assign(). */
function freshState() {
  return {
    byId: new Map(), // thread_id -> {id, room_id, root_tseq, first_t, last_t, last_tseq, count, participants:Set}
    openPair: new Map(), // pairKey -> thread_id
    current: null, // thread_id of the room's currently open thread
  };
}

function stateOf(room) {
  if (!room._threadState) room._threadState = freshState();
  return room._threadState;
}

function newThread(room, st, ev) {
  const id = `th-${room.id}-${ev.tseq}`;
  const th = {
    id,
    room_id: room.id,
    root_tseq: ev.tseq,
    first_t: ev.t,
    last_t: ev.t,
    last_tseq: ev.tseq,
    count: 0,
    participants: new Set(),
  };
  st.byId.set(id, th);
  return th;
}

function touch(th, ev) {
  th.last_t = ev.t;
  th.last_tseq = ev.tseq;
  th.count += 1;
  th.participants.add(ev.from);
  if (ev.to) th.participants.add(ev.to);
}

/**
 * Assign ev.thread_id. Mutates room._threadState. Requires ev.tseq and
 * ev.t to be set. Pure function of (room state, ev) — replaying stored
 * events in order reproduces the same threads.
 *
 * An event only continues a thread it chronologically follows. A
 * past-dated (out-of-order) event gets its own thread and leaves the
 * room's live pointers (current thread, pair map) undisturbed.
 */
function assign(room, ev) {
  const st = stateOf(room);
  const pk = ev.to ? pairKey(ev.from, ev.to) : null;
  const pairTh = pk ? st.byId.get(st.openPair.get(pk)) : null;
  const curTh = st.current ? st.byId.get(st.current) : null;
  const continues = (cand, window) => {
    if (!cand) return false;
    const dt = ev.t - cand.last_t;
    return dt >= 0 && dt <= window;
  };
  let th = null;
  if (ev.to && continues(pairTh, PAIR_WINDOW_MS)) th = pairTh;
  if (!th && continues(curTh, THREAD_GAP_MS)) th = curTh;
  if (!th) {
    th = newThread(room, st, ev);
    // Expire a pair mapping only when a live event runs past its window.
    if (pk && pairTh && ev.t - pairTh.last_t > PAIR_WINDOW_MS) st.openPair.delete(pk);
  }
  // Past-dated events never hijack the pair map or the current pointer.
  if (pk && (!pairTh || ev.t >= pairTh.last_t)) st.openPair.set(pk, th.id);
  if (!curTh || ev.t >= curTh.last_t) st.current = th.id;
  touch(th, ev);
  ev.thread_id = th.id;
  return th.id;
}

/** Rebuild thread state for a room from its (loaded) transcript. */
function rebuild(room) {
  room._threadState = freshState();
  room.tseq = 0;
  for (const ev of room.transcript) {
    if (!ev.tseq) ev.tseq = ++room.tseq;
    else if (ev.tseq > room.tseq) room.tseq = ev.tseq;
    if (!ev.ev_id) ev.ev_id = "e-" + crypto.randomUUID();
    if (!ev.t) ev.t = 0;
    // Re-derive: the persisted thread_id is authoritative when present
    // (assignment happened once at ingest); otherwise compute it.
    if (ev.thread_id && THREAD_ID_RE.test(ev.thread_id)) {
      const st = stateOf(room);
      let th = st.byId.get(ev.thread_id);
      if (!th) {
        th = {
          id: ev.thread_id, room_id: room.id, root_tseq: ev.tseq,
          first_t: ev.t, last_t: ev.t, last_tseq: ev.tseq, count: 0,
          participants: new Set(),
        };
        st.byId.set(ev.thread_id, th);
      }
      if (ev.to) st.openPair.set(pairKey(ev.from, ev.to), th.id);
      st.current = th.id;
      touch(th, ev);
    } else {
      assign(room, ev);
    }
  }
}

/** Find a thread by id across public persistent rooms. Returns {room, thread} or null. */
function findThread(rooms, threadId) {
  const m = THREAD_ID_RE.exec(String(threadId || ""));
  if (!m) return null;
  const room = rooms.get(m[1]);
  if (!room || room.visibility !== "public" || !room.persistent) return null;
  const th = stateOf(room).byId.get(threadId);
  if (!th) return null;
  return { room, thread: th };
}

function threadEvents(room, threadId) {
  return room.transcript.filter((e) => e.thread_id === threadId);
}

function summarize(th) {
  return {
    id: th.id,
    room_id: th.room_id,
    participants: [...th.participants],
    count: th.count,
    first_t: th.first_t,
    last_t: th.last_t,
  };
}

/** Newest-first thread summaries for a room (public persistent only). */
function listThreads(room, limit = 20) {
  if (!room || room.visibility !== "public" || !room.persistent) return [];
  const st = stateOf(room);
  return [...st.byId.values()]
    .sort((a, b) => b.last_t - a.last_t || b.root_tseq - a.root_tseq)
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(summarize);
}

// --- HTML reading view -------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colorFor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 45%, 55%)`;
}

function fmtTime(t) {
  try {
    return new Date(t).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return ""; }
}

function avatarHtml(ev) {
  const sp = ev.sp || {};
  if (sp.img) {
    return `<span class="av"><img src="${esc(sp.img)}" alt="" loading="lazy"></span>`;
  }
  const emoji = sp.e || "";
  const color = sp.c || colorFor(ev.from);
  return `<span class="av" style="background:${esc(color)}">${esc(emoji)}</span>`;
}

function renderThreadPage(room, th, events) {
  const msgs = events.map((ev) => {
    const sp = ev.sp || {};
    const badges = [];
    if (sp.v === "verified") badges.push(`<span class="badge" title="identity verified">verified</span>`);
    const toLine = ev.to ? `<span class="to">to ${esc(ev.to)}</span>` : "";
    return `<article class="msg">
      ${avatarHtml(ev)}
      <div class="body">
        <div class="meta"><span class="name">${esc(ev.from)}</span>${badges.join("")}${toLine}
        <time datetime="${new Date(ev.t).toISOString()}" title="${new Date(ev.t).toISOString()}">${esc(fmtTime(ev.t))}</time></div>
        <p>${esc(ev.text)}</p>
      </div>
    </article>`;
  }).join("\n");
  const names = [...th.participants].join(", ");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thread in #${esc(room.id)} | Muse Commons</title>
<style>
  body{font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:24px 16px;color:#1a1a1a;line-height:1.5}
  header{border-bottom:2px solid #1a1a1a;padding-bottom:12px;margin-bottom:20px}
  header .brand{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#666}
  header h1{font-size:22px;margin:6px 0}
  header .sub{color:#666;font-size:14px}
  .msg{display:flex;gap:12px;margin:0 0 18px}
  .av{flex:0 0 40px;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;overflow:hidden;color:#fff}
  .av img{width:100%;height:100%;object-fit:cover}
  .meta{font-size:13px;color:#666;margin-bottom:2px}
  .name{font-weight:bold;color:#1a1a1a;margin-right:6px}
  .badge{font-size:11px;border:1px solid #2a7;border-radius:8px;padding:0 6px;color:#2a7;margin-right:6px}
  .to{font-style:italic;margin-right:6px}
  time{font-size:12px}
  .body p{margin:2px 0 0;white-space:pre-wrap;word-wrap:break-word}
  footer{margin-top:28px;padding-top:12px;border-top:1px solid #ccc;font-size:13px;color:#666}
  a{color:#1a1a1a}
</style></head><body>
<header>
  <div class="brand">Muse Commons</div>
  <h1>A conversation in #${esc(room.id)}</h1>
  <div class="sub">${esc(room.topic || "")} &middot; ${th.count} message${th.count === 1 ? "" : "s"} &middot; ${esc(names)}</div>
</header>
<main>${msgs}</main>
<footer>Public room. Muse Commons is early and in testing.
<a href="/">Back to the lobby</a></footer>
</body></html>`;
}

module.exports = {
  THREAD_GAP_MS, PAIR_WINDOW_MS, THREAD_ID_RE,
  freshState, assign, rebuild, findThread, threadEvents, listThreads, summarize,
  renderThreadPage, esc,
};
