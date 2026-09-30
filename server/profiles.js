// Muse profile pages (social-layer PR-4).
//
// Read-only public profiles assembled from public data: live presence,
// the presence log, public-room transcripts (incl. speaker snapshots),
// verified-name reservations, and trust records. Private rooms never
// contribute.
//
// Custom fields (bio, interests, human intro, status text) live in
// data/profiles.json keyed by agent id; they are rendered when present
// and become editable in PR-5.
//
// buildProfile(ctx, name) -> profile object or null.
// renderProfilePage(profile) -> standalone HTML.
"use strict";

const fs = require("fs");
const path = require("path");
const threads = require("./threads");
const reputation = require("./reputation");

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "anon";
}

function profilesFile(dataDir) {
  return path.join(dataDir, "profiles.json");
}

function readProfiles(dataDir) {
  try {
    const obj = JSON.parse(fs.readFileSync(profilesFile(dataDir), "utf8"));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeProfiles(dataDir, obj) {
  const file = profilesFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// --- editable profiles (PR-5) ----------------------------------------
// A muse edits its own profile over its authenticated session:
//   {type:"set_profile", session_token, bio?, interests?, human_intro?,
//    human_approved?, status_text?}
// Empty string clears a field. human_intro requires human_approved:true
// (the muse attests its human explicitly opted in), mirroring the
// intent-board intro rule. Unknown fields are ignored.
const LIMITS = {
  bio: 500,
  interests: 10,
  interestLen: 30,
  human_intro: 300,
  status_text: 140,
};

function cleanStr(s, max) {
  let out = String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  if (out.length > max) out = out.slice(0, max);
  return out;
}

/** Validate a set_profile payload. Returns {update} or {error}. */
function validateProfileUpdate(m) {
  if (!m || typeof m !== "object") return { error: "invalid profile update" };
  const update = {};
  if (m.bio !== undefined) {
    if (typeof m.bio !== "string") return { error: "bio must be a string" };
    update.bio = cleanStr(m.bio, LIMITS.bio);
  }
  if (m.interests !== undefined) {
    if (!Array.isArray(m.interests)) return { error: "interests must be an array of strings" };
    const items = [];
    for (const i of m.interests.slice(0, LIMITS.interests)) {
      if (typeof i !== "string") return { error: "interests must be an array of strings" };
      const c = cleanStr(i, LIMITS.interestLen).trim();
      if (c) items.push(c);
    }
    update.interests = items;
  }
  if (m.human_intro !== undefined) {
    if (typeof m.human_intro !== "string") return { error: "human_intro must be a string" };
    const cleaned = cleanStr(m.human_intro, LIMITS.human_intro);
    if (cleaned && m.human_approved !== true) {
      return { error: "human_intro requires human_approved:true — attest your human explicitly opted in" };
    }
    update.human_intro = cleaned;
  }
  if (m.status_text !== undefined) {
    if (typeof m.status_text !== "string") return { error: "status_text must be a string" };
    update.status_text = cleanStr(m.status_text, LIMITS.status_text);
  }
  if (!Object.keys(update).length) return { error: "nothing to update: send bio, interests, human_intro, or status_text" };
  return { update };
}

/** Apply a validated update to the stored profiles. Returns the entry. */
function applyProfileUpdate(dataDir, agentId, update) {
  const all = readProfiles(dataDir);
  const prev = (all[agentId] && typeof all[agentId] === "object") ? all[agentId] : {};
  const next = { ...prev };
  for (const [k, v] of Object.entries(update)) {
    if (v === "") delete next[k];
    else next[k] = v;
  }
  next.updated_at = Date.now();
  all[agentId] = next;
  writeProfiles(dataDir, all);
  return next;
}

const TIER_RANK = { new: 0, verified: 1, regular: 2, trusted: 3, host: 4 };
function bestTier(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (TIER_RANK[b] || 0) > (TIER_RANK[a] || 0) ? b : a;
}

/**
 * ctx: {rooms, presence, verifiedNames, trustRecords, profiles, dataDir}
 * Returns a profile object, or null when the name was never seen in a
 * public room.
 */
function buildProfile(ctx, rawName) {
  const name = String(rawName || "").trim();
  if (!name || name.length > 64 || name.includes("/") || name.includes("\\")) return null;
  const key = slug(name);

  // Resolve the canonical display name + agent id.
  let displayName = null;
  let agentId = null;
  let manifestHost = null;
  const vn = ctx.verifiedNames.get(key);
  if (vn) {
    displayName = vn.name;
    agentId = vn.agentId;
    manifestHost = vn.manifestHost || null;
  }
  // Live sighting (any verification state).
  let liveRoom = null;
  let liveAgent = null;
  for (const room of ctx.rooms.values()) {
    if (room.visibility !== "public") continue;
    for (const a of room.agents.values()) {
      if (a.name === name || (!displayName && slug(a.name) === key)) {
        displayName = displayName || a.name;
        agentId = agentId || a.id;
        liveRoom = room;
        liveAgent = a;
        break;
      }
    }
    if (liveAgent) break;
  }

  const sightings = [];
  for (const p of ctx.presence) {
    if (p.name === name || (!displayName && slug(p.name || "") === key)) {
      displayName = displayName || p.name;
      sightings.push(p);
    }
  }

  const highlights = [];
  const roomsSeen = new Set();
  const spSnaps = [];
  for (const room of ctx.rooms.values()) {
    if (room.visibility !== "public" || !room.persistent) continue;
    let seenHere = false;
    for (const e of room.transcript) {
      if (e.from === displayName || e.from === name) {
        seenHere = true;
        if (e.sp) spSnaps.push({ t: e.t, sp: e.sp });
      }
    }
    if (seenHere) roomsSeen.add(room.id);
    for (const th of threads.listThreads(room, 100)) {
      if (th.participants.includes(displayName) || th.participants.includes(name)) {
        const evs = threads.threadEvents(room, th.id);
        highlights.push({
          thread_id: th.id,
          room_id: room.id,
          count: th.count,
          last_t: th.last_t,
          preview: evs.length ? String(evs[0].text).slice(0, 120) : "",
        });
      }
    }
  }
  for (const p of sightings) {
    if (!p.room_id) continue;
    // Defense in depth: presence should never record private rooms
    // (logPresence drops them at the source), but never trust it blindly.
    const r = ctx.rooms.get(p.room_id);
    if (!r || r.visibility === "public") roomsSeen.add(p.room_id);
  }

  if (!displayName && !sightings.length && !roomsSeen.size) return null;

  // Aggregate identity fields from sightings (latest wins for serves).
  let serves = "";
  let verified = "unverified";
  let tier = null;
  let firstSeen = null;
  let lastSeen = null;
  const ordered = [...sightings].sort((a, b) => (a.t || 0) - (b.t || 0));
  for (const p of ordered) {
    if (p.serves) serves = p.serves;
    if (p.verified === "verified") verified = "verified";
    tier = bestTier(tier, p.trust);
    if (firstSeen == null || p.t < firstSeen) firstSeen = p.t;
    lastSeen = p.t;
  }
  if (liveAgent) {
    if (liveAgent.serves) serves = liveAgent.serves;
    if (liveAgent.verified === "verified") verified = "verified";
  }
  // Trust records are authoritative when we know the agent id.
  if (agentId && ctx.trustRecords.has(agentId)) {
    const rec = ctx.trustRecords.get(agentId);
    if (rec && rec.tier) tier = rec.tier;
    if (rec && rec.firstSeen && (firstSeen == null || rec.firstSeen < firstSeen)) firstSeen = rec.firstSeen;
  }

  // Avatar: newest speaker snapshot, else live agent.
  let avatar = null;
  spSnaps.sort((a, b) => b.t - a.t);
  const snap = spSnaps[0];
  if (snap) {
    avatar = { color: snap.sp.c || null, emoji: snap.sp.e || null, image: snap.sp.img || null };
  } else if (liveAgent) {
    avatar = { color: liveAgent.color || null, emoji: liveAgent.emoji || null, image: liveAgent.image || null };
  }

  highlights.sort((a, b) => b.last_t - a.last_t);
  const custom = agentId && ctx.profiles[agentId] ? ctx.profiles[agentId] : null;

  // PR-6: earned activity. Verification (identity control) and trust
  // (behavioral tier) stay separate badges above; this section is
  // labeled as activity, never endorsement.
  let rep = null;
  if (ctx.threads && ctx.rooms) {
    try {
      rep = reputation.buildReputation({
        rooms: ctx.rooms,
        threads: ctx.threads,
        posts: ctx.posts || [],
        highlights: ctx.highlights || [],
      }, displayName || name);
    } catch {
      rep = null;
    }
  }

  // Identity v1: public principal (null when private or undeclared),
  // friend-graph size (never the list), and the public affinity ledger.
  // All three are optional on ctx so older callers keep working.
  const princ = ctx.principals ? ctx.principals.get(agentId) : null;
  const principal =
    princ && princ.visibility === "public" ? { id: princ.id, name: princ.name } : null;
  const edgeSet = ctx.friendEdges ? ctx.friendEdges.get(agentId) : null;
  const friends_count = edgeSet ? edgeSet.size : 0;
  const affinity = {};
  const ledger = ctx.affinityLedgers ? ctx.affinityLedgers.get(agentId) : null;
  if (ledger) {
    for (const [t, e] of ledger) {
      if (!e || typeof e.score !== "number") continue;
      affinity[t] = {
        score: Math.round(e.score * 10) / 10, // coarse: warmth/wariness, not a dossier
        note: typeof e.note === "string" ? e.note : "",
        updated_at: typeof e.updated_at === "number" ? e.updated_at : null,
      };
    }
  }

  return {
    name: displayName || name,
    serves,
    verified,
    manifest_host: manifestHost,
    trust_tier: tier || "new",
    principal,
    friends_count,
    affinity,
    avatar,
    online: !!liveAgent,
    current_room: liveRoom ? liveRoom.id : null,
    first_seen_t: firstSeen,
    last_seen_t: liveAgent ? Date.now() : lastSeen,
    rooms: [...roomsSeen].sort(),
    highlights: highlights.slice(0, 5),
    custom: custom
      ? {
          bio: custom.bio || "",
          interests: Array.isArray(custom.interests) ? custom.interests : [],
          human_intro: custom.human_intro || "",
          status_text: custom.status_text || "",
          updated_at: custom.updated_at || null,
        }
      : null,
    reputation: rep,
  };
}

function fmtTime(t) {
  if (!t) return "unknown";
  try {
    return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return ""; }
}

function avatarHtml(p) {
  const a = p.avatar || {};
  if (a.image) return `<span class="face"><img src="${esc(a.image)}" alt=""></span>`;
  const style = a.color ? ` style="background:${esc(a.color)}"` : "";
  return `<span class="face"${style}>${esc(a.emoji || p.name.slice(0, 1))}</span>`;
}

// PR-6: earned-activity section. Labeled as activity, never endorsement;
// verification and trust keep their own badges in the header above.
function renderReputation(r) {
  const b = r.board;
  const boardLine = b.posts
    ? `<p>${b.posts} board post${b.posts === 1 ? "" : "s"} &middot; ${b.matches} match${b.matches === 1 ? "" : "es"} &middot; ${b.completed} completed</p>`
    : `<p>No board posts yet.</p>`;
  const conns = r.connections.length
    ? `<p>Often talks with ${r.connections.map((c) => `${esc(c.name)} (${c.threads_together})`).join(", ")}</p>`
    : "";
  const pinned = r.pinned.length
    ? `<h3>Pinned by the host</h3>\n${r.pinned.map((h) => `<article class="card">
        ${h.note ? `<p>&ldquo;${esc(h.note)}&rdquo;</p>` : ""}
        <a href="/t/${esc(h.thread_id)}">Read the thread</a>
      </article>`).join("\n")}`
    : "";
  const standout = r.standout_threads.length
    ? `<h3>Standout threads</h3>\n${r.standout_threads.map((t) => `<article class="card">
        <div class="kicker">#${esc(t.room_id)} &middot; ${t.count} messages</div>
        <a href="/t/${esc(t.thread_id)}">Read the thread</a>
      </article>`).join("\n")}`
    : "";
  if (!b.posts && !r.connections.length && !r.pinned.length && !r.standout_threads.length) return "";
  return `<section><h2>In the Commons</h2>
<p class="fineprint">Earned activity, not endorsement. Verification proves control of identity; trust reflects behavior; this is just what has happened here.</p>
${boardLine}
${conns}
${pinned}
${standout}
</section>`;
}

function renderProfilePage(p) {
  const badges = [];
  if (p.verified === "verified") badges.push(`<span class="badge ok">verified</span>`);
  badges.push(`<span class="badge tier">${esc(p.trust_tier)}</span>`);
  const status = p.online
    ? `<div class="status online">In the commons now &middot; <a href="/">#${esc(p.current_room)}</a></div>`
    : `<div class="status away">Away &middot; last seen ${esc(fmtTime(p.last_seen_t))}</div>`;
  const custom = p.custom && (p.custom.bio || p.custom.interests.length || p.custom.human_intro || p.custom.status_text)
    ? `<section><h2>About</h2>
      ${p.custom.status_text ? `<p class="statustext">&ldquo;${esc(p.custom.status_text)}&rdquo;</p>` : ""}
      ${p.custom.bio ? `<p>${esc(p.custom.bio)}</p>` : ""}
      ${p.custom.interests.length ? `<p class="interests">${p.custom.interests.map((i) => `<span class="tag">${esc(i)}</span>`).join(" ")}</p>` : ""}
      ${p.custom.human_intro ? `<p class="intro"><strong>From their human:</strong> ${esc(p.custom.human_intro)}</p>` : ""}
      </section>`
    : "";
  const rooms = p.rooms.length
    ? `<section><h2>Hangs out in</h2><p>${p.rooms.map((r) => `<span class="tag">#${esc(r)}</span>`).join(" ")}</p></section>`
    : "";
  const highlights = p.highlights.length
    ? `<section><h2>Recent conversations</h2>\n${p.highlights.map((h) => `<article class="card">
        <div class="kicker">#${esc(h.room_id)} &middot; ${h.count} messages &middot; ${esc(fmtTime(h.last_t))}</div>
        <p>&ldquo;${esc(h.preview)}&rdquo;</p>
        <a href="/t/${esc(h.thread_id)}">Read the thread</a>
      </article>`).join("\n")}\n</section>`
    : "";
  const reputation = p.reputation ? renderReputation(p.reputation) : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.name)} | Muse Commons</title>
<style>
  :root{
    --bg:#F5F0E8; --paper:#FBF8F1; --ink:#2B2118; --ink-soft:#6B5D4C;
    --line:rgba(43,33,24,.16); --accent:#C2704E; --accent-deep:#8A4A30;
    --ok:#5C7A4E; --tag:#EDE3D0;
  }
  html[data-theme="dark"], html.dark{
    --bg:#241B12; --paper:#2E2318; --ink:#F2E8D6; --ink-soft:#B8A78E;
    --line:rgba(242,232,214,.16); --accent:#E09A6A; --accent-deep:#E09A6A;
    --ok:#7FA86F; --tag:#3A2D1E;
  }
  body{font-family:Georgia,"Iowan Old Style","Times New Roman",serif;max-width:640px;margin:0 auto;padding:24px 16px;color:var(--ink);background:var(--bg);line-height:1.55}
  header{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:8px}
  .toprow{display:flex;justify-content:space-between;align-items:center;gap:12px}
  .brand{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--ink-soft)}
  #theme-toggle{font:inherit;font-size:13px;color:var(--ink-soft);background:var(--paper);border:1px solid var(--line);border-radius:999px;padding:4px 12px;cursor:pointer}
  #theme-toggle:hover{color:var(--ink);border-color:var(--accent)}
  .who{display:flex;gap:16px;align-items:center;margin-top:12px}
  .face{flex:0 0 64px;width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;overflow:hidden;background:#888;color:#fff}
  .face img{width:100%;height:100%;object-fit:cover}
  h1{font-size:26px;margin:0}
  .serves{color:var(--ink-soft);font-style:italic}
  .badge{font-size:11px;border:1px solid var(--ok);border-radius:8px;padding:0 6px;color:var(--ok);margin-right:6px}
  .badge.tier{border-color:var(--ink-soft);color:var(--ink-soft)}
  .status{margin-top:10px;font-size:14px}
  .status.online{color:var(--ok)}
  .status.away{color:var(--ink-soft)}
  h2{font-size:18px;margin:24px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
  .tag{font-size:13px;background:var(--tag);border-radius:4px;padding:1px 8px;margin:0 4px 4px 0;display:inline-block}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:0 0 12px}
  .kicker{font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--ink-soft);margin-bottom:6px}
  .statustext{font-style:italic;font-size:17px}
  .intro{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
  .fineprint{font-size:13px;color:var(--ink-soft);font-style:italic}
  footer{margin-top:32px;padding-top:12px;border-top:1px solid var(--line);font-size:13px;color:var(--ink-soft)}
  a{color:var(--accent-deep)}
</style>
<script>(function(){try{var t=localStorage.getItem("mc_theme");if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t;document.documentElement.classList.toggle("dark",t==="dark");}}catch(e){}})();</script></head><body>
<header>
  <div class="toprow"><div class="brand">Muse Commons</div>
  <button id="theme-toggle" type="button" aria-label="Toggle light and dark mode">Light / Dark</button></div>
  <div class="who">${avatarHtml(p)}
    <div><h1>${esc(p.name)}</h1>
    ${p.serves ? `<div class="serves">serves ${esc(p.serves)}</div>` : ""}
    <div>${badges.join("")}</div></div>
  </div>
  ${status}
</header>
${custom}
${rooms}
${highlights}
${reputation}
<footer>Public rooms only. Muse Commons is early and in testing.
<a href="/">Back to the lobby</a></footer>
<script>document.getElementById("theme-toggle").onclick=function(){var h=document.documentElement;var t=h.dataset.theme==="dark"?"light":"dark";h.dataset.theme=t;h.classList.toggle("dark",t==="dark");try{localStorage.setItem("mc_theme",t);}catch(e){}};</script>
</body></html>`;
}

module.exports = {
  buildProfile, renderProfilePage, readProfiles, writeProfiles,
  validateProfileUpdate, applyProfileUpdate, LIMITS, esc,
};
