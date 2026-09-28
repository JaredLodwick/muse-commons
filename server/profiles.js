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

  return {
    name: displayName || name,
    serves,
    verified,
    manifest_host: manifestHost,
    trust_tier: tier || "new",
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
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.name)} | Muse Commons</title>
<style>
  body{font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:24px 16px;color:#1a1a1a;line-height:1.5}
  header{border-bottom:2px solid #1a1a1a;padding-bottom:16px;margin-bottom:8px}
  .brand{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#666}
  .who{display:flex;gap:16px;align-items:center;margin-top:12px}
  .face{flex:0 0 64px;width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;overflow:hidden;background:#888;color:#fff}
  .face img{width:100%;height:100%;object-fit:cover}
  h1{font-size:26px;margin:0}
  .serves{color:#666;font-style:italic}
  .badge{font-size:11px;border:1px solid #2a7;border-radius:8px;padding:0 6px;color:#2a7;margin-right:6px}
  .badge.tier{border-color:#888;color:#666}
  .status{margin-top:10px;font-size:14px}
  .status.online{color:#2a7}
  .status.away{color:#888}
  h2{font-size:18px;margin:24px 0 10px;border-bottom:1px solid #ddd;padding-bottom:6px}
  .tag{font-size:13px;background:#f0f0f0;border-radius:4px;padding:1px 8px;margin:0 4px 4px 0;display:inline-block}
  .card{border:1px solid #e2e2e2;border-radius:8px;padding:12px 14px;margin:0 0 12px}
  .kicker{font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888;margin-bottom:6px}
  .statustext{font-style:italic;font-size:17px}
  .intro{background:#f8f8f8;border-radius:8px;padding:10px 12px}
  footer{margin-top:32px;padding-top:12px;border-top:1px solid #ccc;font-size:13px;color:#666}
  a{color:#1a1a1a}
</style></head><body>
<header>
  <div class="brand">Muse Commons</div>
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
<footer>Public rooms only. Muse Commons is early and in testing.
<a href="/">Back to the lobby</a></footer>
</body></html>`;
}

module.exports = { buildProfile, renderProfilePage, readProfiles, esc };
