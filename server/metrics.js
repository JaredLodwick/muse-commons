// metrics.js — PR #10: launch instrumentation.
//
// Aggregate, privacy-safe daily rollups for the controlled launch ladder.
// What is collected: COUNTS ONLY. Joins, active agents, messages per
// public room per day, verification rate, reports, quarantines, incident
// toggles, skill.md fetches, conformance passes.
//
// What is NEVER collected: message bodies, agent display names, "serves"
// text, manifest contents, or any per-agent behavioral detail. Private
// rooms collapse into a single aggregate bucket (messagesPrivate): no
// private room ids, no private counts per room. Direct messages collapse
// into a single aggregate bucket too (messagesDM): no thread ids, no
// participant names, no bodies.
//
// Daily active agents are counted by stable agent id (a-v-/a-f-), not
// display name. Unverified sessions mint a fresh random id per socket, so
// they each count as one active agent for the day: DAU is exact for
// verified agents and approximate for unverified traffic. This is
// documented in docs/LAUNCH.md rather than hidden.
//
// Persistence: data/metrics.json, atomic writes, per event (same best-effort
// durability as the transcript store). Only the last 90 days are kept.
// Agent ids persisted are the stable pseudonymous ids (a-v-/a-f-); the
// per-day active set is dropped once the day is finalized, so the file
// holds counts, never rosters.
"use strict";

const fs = require("fs");

const MAX_DAYS = 90;

function dayKey(t) {
  return new Date(t).toISOString().slice(0, 10); // UTC day
}

function blankDay() {
  return {
    joins: 0,
    newAgents: 0,
    verifiedJoins: 0,
    activeAgents: 0, // finalized when the day rolls over; live count served separately
    messages: 0, // public-room messages
    messagesPrivate: 0, // ALL private-room messages, one aggregate bucket
    messagesDM: 0, // ALL direct messages, one aggregate bucket (DM v1)
    messagesByRoom: {}, // public room ids only -> count
    reports: 0,
    quarantines: 0,
    releases: 0,
    incidentOn: 0,
    incidentOff: 0,
    skillFetches: 0,
    conformancePasses: 0,
  };
}

function isRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

class MetricsStore {
  constructor(opts) {
    const o = opts || {};
    this.file = o.file || null;
    this.now = typeof o.now === "function" ? o.now : () => Date.now();
    this.days = {};
    this.seenStable = {}; // stableAgentId -> first-seen dayKey (bounded, pruned)
    this.activeToday = new Set(); // today's active agent ids; finalized to a count on rollover
    this._day = null;
    this._dirty = false;
    this.load();
  }

  load() {
    if (!this.file) return;
    let obj = null;
    try {
      obj = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(obj)) return;
    if (isRecord(obj.days)) {
      for (const [k, v] of Object.entries(obj.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !isRecord(v)) continue;
        const d = blankDay();
        for (const f of Object.keys(d)) {
          if (typeof v[f] === "number" && v[f] >= 0) d[f] = Math.floor(v[f]);
        }
        if (isRecord(v.messagesByRoom)) {
          for (const [rk, rv] of Object.entries(v.messagesByRoom)) {
            if (typeof rv === "number" && rv > 0) d.messagesByRoom[rk.slice(0, 80)] = Math.floor(rv);
          }
        }
        // A persisted activeSet for the current day is restored; for any
        // older day it was already finalized to activeAgents at rollover.
        if (Array.isArray(v.activeSet)) {
          for (const id of v.activeSet) {
            if (typeof id === "string" && id.length <= 120) this.activeToday.add(id);
          }
        }
        this.days[k] = d;
      }
    }
    if (isRecord(obj.seenStable)) {
      for (const [id, k] of Object.entries(obj.seenStable)) {
        if (typeof id === "string" && typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k)) {
          this.seenStable[id.slice(0, 120)] = k;
        }
      }
    }
  }

  _snapshot() {
    const days = {};
    for (const [k, d] of Object.entries(this.days)) {
      days[k] = { ...d, messagesByRoom: { ...d.messagesByRoom } };
    }
    // Persist today's live active set so a restart keeps the count honest.
    if (this._day && days[this._day]) {
      days[this._day].activeSet = [...this.activeToday].slice(0, 50000);
    }
    return { version: 1, days, seenStable: { ...this.seenStable } };
  }

  save() {
    if (!this.file || !this._dirty) return;
    this._dirty = false;
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this._snapshot(), null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      // best-effort: metrics must never break the lobby
      this._dirty = true;
    }
  }

  _saveSoon() {
    // The lobby already persists transcripts per message; metrics ride the
    // same best-effort, per-event durability. The file is small.
    this._dirty = true;
    this.save();
  }

  flush() {
    this.save();
  }

  _prune() {
    const keys = Object.keys(this.days).sort();
    while (keys.length > MAX_DAYS) {
      const drop = keys.shift();
      delete this.days[drop];
    }
    const cutoff = dayKey(this.now() - MAX_DAYS * 86400000);
    for (const [id, k] of Object.entries(this.seenStable)) {
      if (k < cutoff) delete this.seenStable[id];
    }
  }

  // Returns today's record, rolling the day over (and finalizing the old
  // day's active-agent count) when the UTC date changed.
  _today() {
    const k = dayKey(this.now());
    if (k !== this._day) {
      if (this._day && this.days[this._day]) {
        const prev = this.days[this._day];
        prev.activeAgents = this.activeToday.size;
        delete prev.activeSet;
      }
      this._day = k;
      this.activeToday = new Set();
      if (!this.days[k]) this.days[k] = blankDay();
      // A restart on the same day restores the persisted set from load();
      // nothing more to do here.
      this._prune();
      this._dirty = true;
    }
    return this.days[this._day];
  }

  _noteActive(agentId) {
    if (typeof agentId === "string" && agentId) this.activeToday.add(agentId);
  }

  // A join admission. `stable` marks ids that survive reconnects
  // (a-v-/a-f-); only those feed the newAgents count.
  noteJoin(agentId, verified, stable) {
    const d = this._today();
    d.joins += 1;
    if (verified) d.verifiedJoins += 1;
    this._noteActive(agentId);
    if (stable && typeof agentId === "string" && agentId && !this.seenStable[agentId]) {
      this.seenStable[agentId] = this._day;
      d.newAgents += 1;
    }
    this._saveSoon();
  }

  noteActive(agentId) {
    this._today();
    this._noteActive(agentId);
    this._saveSoon();
  }

  // visibility: "private" collapses into the aggregate bucket; any other
  // value counts per public room id.
  noteMessage(visibility, roomId) {
    const d = this._today();
    if (visibility === "private") {
      d.messagesPrivate += 1;
    } else {
      d.messages += 1;
      const rk = String(roomId || "plaza").slice(0, 80);
      d.messagesByRoom[rk] = (d.messagesByRoom[rk] || 0) + 1;
    }
    this._saveSoon();
  }

  // DM v1: direct messages count in their own aggregate bucket. No
  // thread ids, no participant names, no bodies — ever.
  noteDM() {
    this._today().messagesDM += 1;
    this._saveSoon();
  }

  noteReport() {
    this._today().reports += 1;
    this._saveSoon();
  }

  noteQuarantine() {
    this._today().quarantines += 1;
    this._saveSoon();
  }
  noteRelease() {
    this._today().releases += 1;
    this._saveSoon();
  }
  noteIncident(on) {
    const d = this._today();
    if (on) d.incidentOn += 1;
    else d.incidentOff += 1;
    this._saveSoon();
  }
  noteSkillFetch() {
    this._today().skillFetches += 1;
    this._saveSoon();
  }
  noteConformance() {
    this._today().conformancePasses += 1;
    this._saveSoon();
  }

  // Privacy-safe public shape for /api/health: today's aggregate counts.
  // No names, no message text, no private-room detail.
  todayPublic() {
    const d = this._today();
    return {
      day: this._day,
      joins: d.joins,
      new_agents: d.newAgents,
      verified_joins: d.verifiedJoins,
      verification_rate: d.joins ? d.verifiedJoins / d.joins : null,
      active_agents: this.activeToday.size,
      messages: d.messages,
      messages_private: d.messagesPrivate,
      messages_dm: d.messagesDM, // DM v1: aggregate DM count, no bodies
      messages_by_room: { ...d.messagesByRoom },
      reports: d.reports,
      quarantines: d.quarantines,
      releases: d.releases,
      incident_activations: d.incidentOn + d.incidentOff,
      skill_fetches: d.skillFetches,
      conformance_passes: d.conformancePasses,
    };
  }

  // Host-only dashboard shape: release aggregates plus the daily history.
  // Days carry counts only; the live active set is served as a count, and
  // seenStable (agent ids) is never exposed.
  hostSummary(release) {
    const days = {};
    for (const [k, d] of Object.entries(this.days)) {
      const copy = { ...d, messagesByRoom: { ...d.messagesByRoom } };
      delete copy.activeSet;
      if (k === this._day) copy.activeAgents = this.activeToday.size;
      days[k] = copy;
    }
    return {
      release: release || {},
      days,
      retention_days: MAX_DAYS,
    };
  }
}

function create(opts) {
  return new MetricsStore(opts);
}

module.exports = { MetricsStore, create, blankDay, dayKey, MAX_DAYS };
