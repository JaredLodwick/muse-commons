// Store interface tests: JSON backend round-trip, on-disk format
// compatibility, legacy normalization, identity export, migration
// dry-run, and the MongoDB backend (skipped cleanly without MONGODB_URI).
//
//   node test/store.js
//
// Exit 0 = all pass, 1 = any failure. Never touches the production
// lobby or the repo's real data/ directory.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { openStore, normalizeGraphDoc, EXPORT_FORMAT } = require("../server/store");

let failures = 0;
let skips = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " - " + detail : ""}`);
  }
}
function skip(name, reason) {
  skips++;
  console.log(`  skip ${name} (${reason})`);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-store-test-"));
}

const AGENT = "a-v-testagent00000000000000000000000001";
const TARGET = "a-v-testagent00000000000000000000000002";

async function testJsonRoundTrip() {
  console.log("json backend round-trip");
  const dir = tmpDir();
  const store = openStore({ backend: "json", dataDir: dir });
  await store.ready;
  check("backend reports json", store.backendName === "json");
  const graphs = store.collection("graphs");

  check("get on empty returns null", (await graphs.get(AGENT)) === null);

  const doc = {
    _id: AGENT,
    identity_key_id: "keyid-abc",
    friends: [{ id: "keyid-xyz", since: 123 }],
    affinity: { [TARGET]: { score: 0.5, note: "hello", updated_at: 456 } },
    visibility: { friends: "public" },
    owner_token: "a".repeat(44),
    trust: { tier: "regular", firstSeen: 1, daysSeen: ["2026-10-01"], upheldReports: 0, quarantines: 1, history: [{ t: 2, from: "verified", to: "regular" }] },
  };
  await graphs.put(AGENT, doc);
  const back = await graphs.get(AGENT);
  check("friends round-trip", back.friends.length === 1 && back.friends[0].id === "keyid-xyz" && back.friends[0].since === 123);
  check("affinity round-trip", back.affinity[TARGET] && back.affinity[TARGET].score === 0.5 && back.affinity[TARGET].note === "hello");
  check("visibility round-trip", back.visibility.friends === "public");
  check("owner token round-trip", back.owner_token === "a".repeat(44));
  check("trust round-trip", back.trust.tier === "regular" && back.trust.quarantines === 1);
  check("identity key id kept", back.identity_key_id === "keyid-abc");

  // On-disk format stays byte-compatible with the pre-store layout.
  const rel = JSON.parse(fs.readFileSync(path.join(dir, "relations.json"), "utf8"));
  check("relations.json has the four sections",
    Array.isArray(rel.friends[AGENT]) && typeof rel.affinity[AGENT] === "object" &&
    rel.visibility[AGENT].friends === "public" && rel.owner_tokens[AGENT] === "a".repeat(44));
  const tru = JSON.parse(fs.readFileSync(path.join(dir, "trust.json"), "utf8"));
  check("trust.json keyed by agent id", tru[AGENT] && tru[AGENT].tier === "regular");

  const all = await graphs.all();
  check("all() lists the doc", all.length === 1 && all[0].key === AGENT);

  await graphs.del(AGENT);
  check("del removes the doc", (await graphs.get(AGENT)) === null);
  const rel2 = JSON.parse(fs.readFileSync(path.join(dir, "relations.json"), "utf8"));
  check("del cleans relations.json", !rel2.friends[AGENT] && !rel2.owner_tokens[AGENT]);

  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testLegacyNormalization() {
  console.log("legacy format normalization");
  const dir = tmpDir();
  // relations.json in the old bare-string friend format.
  fs.writeFileSync(
    path.join(dir, "relations.json"),
    JSON.stringify({ friends: { [AGENT]: ["keyid-old"] }, affinity: {}, visibility: {}, owner_tokens: {} })
  );
  const store = openStore({ backend: "json", dataDir: dir });
  await store.ready;
  const back = await store.collection("graphs").get(AGENT);
  check("bare-string friend becomes {id, since:0}",
    back.friends.length === 1 && back.friends[0].id === "keyid-old" && back.friends[0].since === 0);
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testValidation() {
  console.log("validation fails closed");
  // Score clamped, note sliced, bad tier dropped, bad token dropped.
  const doc = normalizeGraphDoc(AGENT, {
    friends: [{ id: "k", since: "not-a-number" }],
    affinity: { t: { score: 99, note: "x".repeat(500), updated_at: 1 } },
    visibility: { friends: "everyone" },
    owner_token: "short",
    trust: { tier: "superadmin" },
  }, { trustTiers: ["new", "verified", "regular", "trusted"], trustHistoryKeep: 50 });
  check("score clamped to 1", doc.affinity.t.score === 1);
  check("note sliced to 140", doc.affinity.t.note.length === 140);
  check("bad visibility dropped", !doc.visibility);
  check("bad owner token dropped", !doc.owner_token);
  check("bad trust tier dropped", !doc.trust);
  check("since defaults to 0", doc.friends[0].since === 0);
  check("bad key rejected", normalizeGraphDoc("", {}, { trustTiers: [], trustHistoryKeep: 50 }) === null);
}

async function testExport() {
  console.log("identity export");
  const dir = tmpDir();
  const store = openStore({ backend: "json", dataDir: dir });
  await store.ready;
  const graphs = store.collection("graphs");
  await graphs.put(AGENT, {
    _id: AGENT,
    identity_key_id: "keyid-abc",
    friends: [{ id: "keyid-xyz", since: 1 }],
    affinity: {},
    owner_token: "b".repeat(44),
    trust: { tier: "verified", firstSeen: 1, daysSeen: [], upheldReports: 0, quarantines: 0, history: [] },
  });
  const dump = await store.exportIdentity(AGENT, "https://lobby.example/");
  check("export format marker", dump.format === EXPORT_FORMAT);
  check("export keyed by identity", dump.identity.agent_id === AGENT && dump.identity.identity_key_id === "keyid-abc");
  check("export carries friends+trust", dump.friends.length === 1 && dump.trust.tier === "verified");
  check("export excludes owner token", !("owner_token" in dump) && JSON.stringify(dump).indexOf("b".repeat(44)) === -1);
  check("export of unknown identity is null", (await store.exportIdentity("a-v-nope", "x")) === null);
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testUnknownCollection() {
  console.log("unknown collections fail loudly");
  const dir = tmpDir();
  const store = openStore({ backend: "json", dataDir: dir });
  await store.ready;
  let threw = false;
  try {
    store.collection("transcripts");
  } catch (e) {
    threw = /unknown collection/.test(e.message);
  }
  check("collection('transcripts') throws", threw);
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testMigrationDryRun() {
  console.log("migration dry-run");
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "relations.json"), JSON.stringify({
    friends: { [AGENT]: [{ id: "keyid-xyz", since: 7 }] },
    affinity: { [AGENT]: { [TARGET]: { score: -0.25, note: "", updated_at: 8 } } },
    visibility: {},
    owner_tokens: {},
  }));
  fs.writeFileSync(path.join(dir, "trust.json"), JSON.stringify({
    [AGENT]: { tier: "trusted", firstSeen: 1, daysSeen: ["2026-10-01"], upheldReports: 0, quarantines: 0, history: [] },
  }));
  const before = fs.readFileSync(path.join(dir, "relations.json"), "utf8");
  process.env.DATA_DIR = dir;
  const { main } = require("../scripts/migrate-to-mongo.js");
  const origArgv = process.argv;
  process.argv = ["node", "migrate-to-mongo.js", "--dry-run"];
  // migrate-to-mongo requires MONGODB_URI even for dry-run; point it at a
  // dummy since dry-run never connects.
  process.env.MONGODB_URI = "mongodb://localhost:27017/unused";
  const res = await main();
  process.argv = origArgv;
  delete process.env.MONGODB_URI;
  delete process.env.DATA_DIR;
  check("dry-run reports the identity", res && res.dryRun === true && res.count === 1, JSON.stringify(res));
  check("dry-run leaves JSON files untouched",
    fs.readFileSync(path.join(dir, "relations.json"), "utf8") === before);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testMongoBackend() {
  console.log("mongo backend");
  if (!process.env.MONGODB_URI) {
    skip("mongo round-trip", "MONGODB_URI not set");
    return;
  }
  const store = openStore({ backend: "mongo", mongoUri: process.env.MONGODB_URI, dbName: "muse_commons_test" });
  await store.ready;
  check("backend reports mongo", store.backendName === "mongo");
  const graphs = store.collection("graphs");
  const key = "a-v-storetest-" + Date.now();
  await graphs.put(key, { _id: key, friends: [{ id: "k", since: 1 }], trust: { tier: "verified", firstSeen: 1, daysSeen: [], upheldReports: 0, quarantines: 0, history: [] } });
  const back = await graphs.get(key);
  check("mongo round-trip", back && back.friends[0].id === "k" && back.trust.tier === "verified");
  const dump = await store.exportIdentity(key, "https://lobby.example/");
  check("mongo export works", dump && dump.identity.agent_id === key);
  await graphs.del(key);
  check("mongo del works", (await graphs.get(key)) === null);
  await store.close();
}

async function testMongoFallback() {
  console.log("mongo fallback");
  const dir = tmpDir();
  const store = openStore({ backend: "mongo", dataDir: dir }); // no MONGODB_URI
  await store.ready;
  check("falls back to json without a URI", store.backendName === "json");
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  await testJsonRoundTrip();
  await testLegacyNormalization();
  await testValidation();
  await testExport();
  await testUnknownCollection();
  await testMigrationDryRun();
  await testMongoFallback();
  await testMongoBackend();
  console.log(failures === 0 ? `\nALL PASS (${skips} skipped)` : `\n${failures} FAILURES (${skips} skipped)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("store test crashed:", err);
  process.exit(1);
});
