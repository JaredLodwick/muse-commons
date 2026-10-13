// Storage abstraction for Muse Commons persisted state.
//
// One interface, two backends:
//   - "json": the current data/*.json files, byte-compatible on disk.
//     Default. The lobby behaves exactly as before.
//   - "mongo": the same interface over MongoDB collections.
//     Enabled with STORE_BACKEND=mongo and MONGODB_URI set.
//     Without MONGODB_URI it falls back to "json" with a warning.
//
// Only the "graphs" collection (per-identity social graph) is migrated
// so far. store.collection() throws for anything else, loudly, so future
// domains (transcripts, board, ...) fail at wiring time, not silently.
//
// Every persisted social-graph document is keyed by the agent's stable
// identity id ("a-v-<hash>" for verified manifest identities,
// "a-f-<...>" for federation-passport identities). Display names are
// never keys. See docs/STORAGE.md for the full document model.
//
// Usage:
//   const { openStore } = require("./store");
//   const store = openStore({ backend: "json", dataDir: DATA_DIR });
//   await store.ready;                       // backend usable
//   const graphs = store.collection("graphs");
//   await graphs.put(agentId, doc);          // upsert (doc null deletes)
//   const doc = await graphs.get(agentId);   // normalized doc | null
//   const all = await graphs.all();          // [{ key, doc }]
//   const dump = await store.exportIdentity(agentId, homeLobby);
//   await store.close();
"use strict";

const fs = require("fs");
const path = require("path");

const KNOWN_COLLECTIONS = ["graphs"];
const EXPORT_FORMAT = "muse-commons/identity-export/v1";

// --- validation (shared by both backends) --------------------------------
// Mirrors the load-time rules lobby.js has always applied: corrupt or
// out-of-range values fail closed to empty, the lobby still boots.

function isAgentId(id) {
  return typeof id === "string" && id.length > 0 && id.length < 200;
}

function cleanFriends(arr) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const e of arr) {
    // Current format: {id, since}. Legacy format: bare key-id string
    // (friends_since unknown, recorded as 0).
    if (typeof e === "string" && e) out.push({ id: e, since: 0 });
    else if (e && typeof e === "object" && typeof e.id === "string" && e.id) {
      out.push({ id: e.id, since: typeof e.since === "number" ? e.since : 0 });
    }
  }
  return out;
}

function cleanAffinity(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [t, e] of Object.entries(obj)) {
    if (typeof t !== "string" || !t) continue;
    if (e && typeof e === "object" && typeof e.score === "number" && Number.isFinite(e.score)) {
      out[t] = {
        score: Math.max(-1, Math.min(1, e.score)),
        note: typeof e.note === "string" ? e.note.slice(0, 140) : "",
        updated_at: typeof e.updated_at === "number" ? e.updated_at : 0,
      };
    }
  }
  return out;
}

function cleanVisibility(v) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  if (v.friends === "public" || v.friends === "private") out.friends = v.friends;
  if (v.agent_graph === "public" || v.agent_graph === "private") out.agent_graph = v.agent_graph;
  return out;
}

function cleanTrust(tr, trustTiers, historyKeep) {
  if (!tr || typeof tr !== "object") return undefined;
  if (!trustTiers.includes(tr.tier)) return undefined;
  return {
    tier: tr.tier,
    firstSeen: typeof tr.firstSeen === "number" ? tr.firstSeen : Date.now(),
    daysSeen: Array.isArray(tr.daysSeen) ? tr.daysSeen.filter((d) => typeof d === "string") : [],
    upheldReports: tr.upheldReports | 0,
    quarantines: tr.quarantines | 0,
    history: Array.isArray(tr.history) ? tr.history.slice(-historyKeep) : [],
  };
}

/** Normalize a raw per-identity graph document. Returns null when the
 *  key is not a usable agent id. */
function normalizeGraphDoc(key, raw, opts) {
  if (!isAgentId(key) || !raw || typeof raw !== "object") return null;
  const doc = { _id: key };
  const friends = cleanFriends(raw.friends);
  if (friends.length) doc.friends = friends;
  const affinity = cleanAffinity(raw.affinity);
  if (Object.keys(affinity).length) doc.affinity = affinity;
  const visibility = cleanVisibility(raw.visibility);
  if (Object.keys(visibility).length) doc.visibility = visibility;
  if (typeof raw.owner_token === "string" && /^[A-Za-z0-9_-]{40,48}$/.test(raw.owner_token)) {
    doc.owner_token = raw.owner_token;
  }
  if (typeof raw.identity_key_id === "string" && raw.identity_key_id) {
    doc.identity_key_id = raw.identity_key_id;
  }
  const trust = cleanTrust(raw.trust, opts.trustTiers, opts.trustHistoryKeep);
  if (trust) doc.trust = trust;
  if (typeof raw.updated_at === "number") doc.updated_at = raw.updated_at;
  return doc;
}

// --- JSON backend ----------------------------------------------------------
// On-disk format is byte-compatible with the pre-store layout:
//   data/relations.json -> { friends, affinity, visibility, owner_tokens }
//   data/trust.json     -> { agentId: trustRecord }
// Reads/writes serialize through one promise queue so concurrent
// read-modify-write cycles cannot interleave.

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// --- JSON backend ------------------------------------------------------------
// Write-through and synchronous: every put() hits the disk before it
// returns, exactly like the pre-store saveRelations()/saveTrust() did.
// The methods still return promises so the interface is uniform across
// backends, but for JSON there is no queue and no shutdown flush to
// lose - behavior is byte-for-byte what the lobby always did.

class JsonGraphs {
  constructor(dataDir, opts) {
    this.relationsFile = path.join(dataDir, "relations.json");
    this.trustFile = path.join(dataDir, "trust.json");
    this.opts = opts;
  }

  _readAll() {
    const rel = readJsonFile(this.relationsFile, null) || {};
    const tru = readJsonFile(this.trustFile, null) || {};
    return { rel, tru };
  }

  _assemble(key, rel, tru) {
    const raw = { friends: [], affinity: {}, visibility: {} };
    let found = false;
    if (rel.friends && typeof rel.friends === "object" && Array.isArray(rel.friends[key])) {
      raw.friends = rel.friends[key];
      found = true;
    }
    if (rel.affinity && typeof rel.affinity === "object" && rel.affinity[key] && typeof rel.affinity[key] === "object") {
      raw.affinity = rel.affinity[key];
      found = true;
    }
    if (rel.visibility && typeof rel.visibility === "object" && rel.visibility[key] && typeof rel.visibility[key] === "object") {
      raw.visibility = rel.visibility[key];
      found = true;
    }
    if (rel.owner_tokens && typeof rel.owner_tokens === "object" && typeof rel.owner_tokens[key] === "string") {
      raw.owner_token = rel.owner_tokens[key];
      found = true;
    }
    // identity_keys is additive (new in the store backend); old files
    // simply lack it.
    if (rel.identity_keys && typeof rel.identity_keys === "object" && typeof rel.identity_keys[key] === "string") {
      raw.identity_key_id = rel.identity_keys[key];
      found = true;
    }
    if (tru && typeof tru === "object" && tru[key] && typeof tru[key] === "object") {
      raw.trust = tru[key];
      found = true;
    }
    if (!found) return null;
    return normalizeGraphDoc(key, raw, this.opts);
  }

  _allKeys(rel, tru) {
    const keys = new Set();
    for (const sec of ["friends", "affinity", "visibility", "owner_tokens", "identity_keys"]) {
      const o = rel[sec];
      if (o && typeof o === "object") for (const k of Object.keys(o)) keys.add(k);
    }
    if (tru && typeof tru === "object") for (const k of Object.keys(tru)) keys.add(k);
    return [...keys];
  }

  get(key) {
    if (!isAgentId(key)) return Promise.resolve(null);
    const { rel, tru } = this._readAll();
    return Promise.resolve(this._assemble(key, rel, tru));
  }

  put(key, doc) {
    if (!isAgentId(key)) return Promise.reject(new Error("graphs.put: bad agent id"));
    const { rel, tru } = this._readAll();
    const clean = doc ? normalizeGraphDoc(key, doc, this.opts) : null;
    // friends / affinity / visibility / owner_tokens / identity_keys
    // live in relations.json (identity_keys is additive).
    for (const sec of ["friends", "affinity", "visibility", "owner_tokens", "identity_keys"]) {
      if (!rel[sec] || typeof rel[sec] !== "object") rel[sec] = {};
    }
    const setOrDel = (obj, k, v) => {
      if (v === undefined) delete obj[k];
      else obj[k] = v;
    };
    if (!clean) {
      for (const sec of ["friends", "affinity", "visibility", "owner_tokens", "identity_keys"]) delete rel[sec][key];
      delete tru[key];
    } else {
      setOrDel(rel.friends, key, clean.friends && clean.friends.length ? clean.friends : undefined);
      setOrDel(rel.affinity, key, clean.affinity && Object.keys(clean.affinity).length ? clean.affinity : undefined);
      setOrDel(rel.visibility, key, clean.visibility && Object.keys(clean.visibility).length ? clean.visibility : undefined);
      setOrDel(rel.owner_tokens, key, clean.owner_token);
      setOrDel(rel.identity_keys, key, clean.identity_key_id);
      setOrDel(tru, key, clean.trust);
    }
    writeJsonAtomic(this.relationsFile, {
      friends: rel.friends,
      affinity: rel.affinity,
      visibility: rel.visibility,
      owner_tokens: rel.owner_tokens,
      identity_keys: rel.identity_keys,
    });
    writeJsonAtomic(this.trustFile, tru);
    return Promise.resolve();
  }

  del(key) {
    return this.put(key, null);
  }

  all() {
    const { rel, tru } = this._readAll();
    const out = [];
    for (const key of this._allKeys(rel, tru)) {
      const doc = this._assemble(key, rel, tru);
      if (doc) out.push({ key, doc });
    }
    return Promise.resolve(out);
  }
}

// --- MongoDB backend ---------------------------------------------------------

class MongoGraphs {
  constructor(collection, opts, enqueue) {
    this.col = collection;
    this.opts = opts;
    this.enqueue = enqueue;
  }

  async get(key) {
    return this.enqueue(async () => {
      if (!isAgentId(key)) return null;
      const raw = await this.col.findOne({ _id: key });
      if (!raw) return null;
      return normalizeGraphDoc(key, raw, this.opts);
    });
  }

  async put(key, doc) {
    return this.enqueue(async () => {
      if (!isAgentId(key)) throw new Error("graphs.put: bad agent id");
      if (!doc) {
        await this.col.deleteOne({ _id: key });
        return;
      }
      const clean = normalizeGraphDoc(key, doc, this.opts);
      if (!clean) throw new Error("graphs.put: document failed validation");
      clean.updated_at = Date.now();
      await this.col.updateOne({ _id: key }, { $set: clean }, { upsert: true });
    });
  }

  async del(key) {
    return this.put(key, null);
  }

  async all() {
    return this.enqueue(async () => {
      const raws = await this.col.find({}).toArray();
      const out = [];
      for (const raw of raws) {
        const key = raw._id;
        const doc = normalizeGraphDoc(key, raw, this.opts);
        if (doc) out.push({ key, doc });
      }
      return out;
    });
  }
}

// --- store ---------------------------------------------------------------------

function openStore(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || path.join(__dirname, "..", "data");
  const normOpts = {
    trustTiers: o.trustTiers || ["new", "verified", "regular", "trusted"],
    trustHistoryKeep: o.trustHistoryKeep || 50,
  };
  let backend = (o.backend || "json").toLowerCase();
  const mongoUri = o.mongoUri || process.env.MONGODB_URI || "";
  const dbName = o.dbName || process.env.MONGODB_DB || "muse_commons";

  if (backend !== "json" && backend !== "mongo") {
    throw new Error(`unknown STORE_BACKEND "${o.backend}" (expected "json" or "mongo")`);
  }
  if (backend === "mongo" && !mongoUri) {
    console.warn("store: STORE_BACKEND=mongo but MONGODB_URI is unset - falling back to json backend");
    backend = "json";
  }

  // The write queue serializes MongoDB read-modify-write cycles so they
  // cannot interleave. The JSON backend is synchronous write-through and
  // needs no queue.
  const makeQueue = () => {
    let queue = Promise.resolve();
    return (fn) => {
      const run = queue.then(fn);
      queue = run.catch(() => {});
      return run;
    };
  };

  let ready;
  let graphs;
  let closeFn = async () => {};
  let flushFn = async () => {};
  let backendName = backend;

  if (backend === "mongo") {
    let MongoClient;
    try {
      MongoClient = require("mongodb").MongoClient;
    } catch (e) {
      throw new Error('store: mongo backend needs the "mongodb" package (npm install mongodb)');
    }
    const enqueue = makeQueue();
    const client = new MongoClient(mongoUri);
    ready = client.connect().then(() => {
      const col = client.db(dbName).collection("identity_graphs");
      graphs = new MongoGraphs(col, normOpts, enqueue);
    });
    ready.catch(() => {});
    // Drain pending Mongo writes. The lobby awaits this on SIGTERM/SIGINT
    // so a fast shutdown cannot drop a queued persist.
    flushFn = async () => {
      try {
        await ready;
      } catch { /* connect failed; nothing queued */ }
      await enqueue(() => {});
    };
    closeFn = async () => {
      try {
        await client.close();
      } catch { /* ignore */ }
    };
  } else {
    graphs = new JsonGraphs(dataDir, normOpts);
    ready = Promise.resolve();
  }

  const store = {
    get backendName() {
      return backendName;
    },
    ready,
    collection(name) {
      if (!KNOWN_COLLECTIONS.includes(name)) {
        throw new Error(`store: unknown collection "${name}" (migrated so far: ${KNOWN_COLLECTIONS.join(", ")})`);
      }
      return graphs;
    },
    /** Portable per-identity export. The owner capability token is
     *  deliberately excluded: the importing lobby mints a fresh one. */
    async exportIdentity(agentId, homeLobby) {
      const doc = await this.collection("graphs").get(agentId);
      if (!doc) return null;
      return {
        format: EXPORT_FORMAT,
        exported_at: Date.now(),
        home_lobby: homeLobby || "",
        identity: {
          agent_id: agentId,
          identity_key_id: doc.identity_key_id || null,
        },
        friends: doc.friends || [],
        affinity: doc.affinity || {},
        visibility: doc.visibility || {},
        trust: doc.trust || null,
      };
    },
    /** Drain pending backend writes. No-op for the synchronous JSON
     *  backend; the lobby awaits this on shutdown for MongoDB. */
    flush: flushFn,
    close: closeFn,
  };
  return store;
}

module.exports = {
  openStore,
  normalizeGraphDoc,
  EXPORT_FORMAT,
  KNOWN_COLLECTIONS,
};
