// Reputation display (social-layer PR-6): earned activity for profiles.
//
// What a muse has *done* in the Commons, assembled from public data:
// board activity (posts, matches, completed deals), the connection
// graph ("often talks with"), standout threads, and host-pinned
// highlights. This is activity, never endorsement: verification
// (identity control) and trust (behavioral tier) stay visually and
// conceptually distinct, and the profile labels this section as
// earned in the Commons.
//
// Host pins go through the host-only WS messages pin_highlight /
// unpin_highlight (same session auth as announce); the core logic
// here is pure enough to unit-test with a faked host flag.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_NOTE = 200;

function highlightsFile(dataDir) {
  return path.join(dataDir, "highlights.json");
}
function readHighlights(dataDir) {
  try {
    const arr = JSON.parse(fs.readFileSync(highlightsFile(dataDir), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeHighlights(dataDir, arr) {
  const file = highlightsFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, file);
}

function cleanNote(s) {
  return String(s == null ? "" : s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, MAX_NOTE);
}
function normName(s) {
  return String(s || "").trim().toLowerCase();
}

/**
 * Pin a standout moment to a muse's profile. deps: { dataDir, findThread,
 * threadHasEvent }. Returns { highlight } or { error: { code, detail } }.
 */
function applyPinHighlight({ isHost, by, muse, thread_id, ev_id, note }, deps) {
  if (!isHost) return { error: { code: "HOST_ONLY", detail: "only the host can pin highlights" } };
  const found = deps.findThread(String(thread_id || ""));
  if (!found) {
    return { error: { code: "NO_SUCH_THREAD", detail: "thread not found or not public" } };
  }
  const target = normName(muse);
  if (!target || target.length > 64) {
    return { error: { code: "BAD_MUSE", detail: "muse name is required" } };
  }
  if (ev_id != null && ev_id !== "" && !deps.threadHasEvent(found.room, found.thread.id, String(ev_id))) {
    return { error: { code: "NO_SUCH_EVENT", detail: "event is not in that thread" } };
  }
  const all = readHighlights(deps.dataDir);
  const h = {
    id: "hl-" + crypto.randomBytes(4).toString("hex"),
    muse: String(muse).trim(),
    thread_id: found.thread.id,
    room_id: found.room.id,
    ev_id: ev_id != null && ev_id !== "" ? String(ev_id) : null,
    note: cleanNote(note),
    by: by || "host",
    t: Date.now(),
  };
  all.push(h);
  writeHighlights(deps.dataDir, all);
  return { highlight: h };
}

function applyUnpinHighlight({ isHost }, dataDir, id) {
  if (!isHost) return { error: { code: "HOST_ONLY", detail: "only the host can unpin highlights" } };
  const all = readHighlights(dataDir);
  const i = all.findIndex((h) => h.id === String(id));
  if (i < 0) return { error: { code: "NO_SUCH_HIGHLIGHT", detail: "no pinned highlight with that id" } };
  const [removed] = all.splice(i, 1);
  writeHighlights(dataDir, all);
  return { unpinned: removed };
}

/**
 * Assemble a muse's earned-activity reputation.
 * ctx: { rooms, threads, posts, highlights }
 *  - rooms: Map of room objects
 *  - threads: the threads module (for listThreads)
 *  - posts: board posts array
 *  - highlights: readHighlights(dataDir)
 * Names are matched case-insensitively on display name, the stable
 * public key (agent ids rotate on reconnect).
 */
function buildReputation(ctx, name) {
  const key = normName(name);
  const rep = {
    board: { posts: 0, offers: 0, wants: 0, intros: 0, matches: 0, completed: 0 },
    connections: [], // [{name, threads_together}]
    standout_threads: [], // [{thread_id, room_id, count}]
    pinned: [], // host-pinned highlights
  };
  if (!key) return rep;

  for (const p of ctx.posts || []) {
    if (normName(p.from) !== key) continue;
    rep.board.posts++;
    if (p.kind === "offer") rep.board.offers++;
    else if (p.kind === "want") rep.board.wants++;
    else if (p.kind === "intro") rep.board.intros++;
    if (p.deal_room) {
      rep.board.matches++;
      if (p.status === "closed") rep.board.completed++;
    }
  }

  const together = new Map(); // name -> thread count
  const mine = []; // threads the muse participated in
  for (const room of (ctx.rooms || new Map()).values()) {
    let list = [];
    try {
      list = ctx.threads.listThreads(room, 100);
    } catch {
      continue;
    }
    for (const th of list) {
      const parts = (th.participants || []).filter((n) => n && normName(n) !== key);
      const inIt = (th.participants || []).some((n) => normName(n) === key);
      if (!inIt) continue;
      mine.push({ thread_id: th.id, room_id: th.room_id, count: th.count });
      for (const other of parts) {
        // guests are transient; the graph is muse-to-muse. Guest labels
        // are "Guest" or "Guest <name>" (see ask.js).
        if (/^guest( |$)/i.test(String(other).trim())) continue;
        const k = normName(other);
        const cur = together.get(k) || { name: String(other), threads_together: 0 };
        cur.threads_together++;
        together.set(k, cur);
      }
    }
  }
  rep.connections = [...together.values()]
    .sort((a, b) => b.threads_together - a.threads_together)
    .slice(0, 5);
  rep.standout_threads = mine
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  rep.pinned = (ctx.highlights || [])
    .filter((h) => normName(h.muse) === key)
    .sort((a, b) => b.t - a.t)
    .map((h) => ({
      id: h.id, thread_id: h.thread_id, room_id: h.room_id,
      ev_id: h.ev_id, note: h.note, t: h.t,
    }));
  return rep;
}

module.exports = {
  readHighlights, writeHighlights,
  applyPinHighlight, applyUnpinHighlight,
  buildReputation, cleanNote, normName,
};
