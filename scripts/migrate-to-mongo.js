// One-shot migration: JSON files -> MongoDB identity_graphs collection.
//
// Reads data/relations.json + data/trust.json through the JSON store
// backend and upserts one document per identity into MongoDB. The JSON
// files are NEVER modified, so rollback is: unset MONGODB_URI (or
// STORE_BACKEND=json) and restart the lobby.
//
// Usage:
//   node scripts/migrate-to-mongo.js --dry-run   # print what would happen
//   node scripts/migrate-to-mongo.js             # perform the migration
//
// Env: MONGODB_URI (required), MONGODB_DB (default "muse_commons"),
//      DATA_DIR (default <repo>/data).
"use strict";

const path = require("path");
const { openStore } = require("../server/store");

async function main() {
  // Evaluated here (not at require time) so tests can set argv before calling.
  const dryRun = process.argv.includes("--dry-run");
  const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("migrate-to-mongo: MONGODB_URI is not set; nothing to migrate to.");
    process.exit(2);
  }

  const src = openStore({ backend: "json", dataDir });
  await src.ready;
  const docs = await src.collection("graphs").all();
  await src.close();

  if (dryRun) {
    console.log(`dry-run: would upsert ${docs.length} identity graph document(s)`);
    for (const { key, doc } of docs.slice(0, 5)) {
      console.log(`  ${key}: friends=${(doc.friends || []).length} affinity=${Object.keys(doc.affinity || {}).length} trust=${doc.trust ? doc.trust.tier : "none"}`);
    }
    if (docs.length > 5) console.log(`  ... and ${docs.length - 5} more`);
    return { migrated: 0, dryRun: true, count: docs.length };
  }

  const dst = openStore({
    backend: "mongo",
    dataDir,
    mongoUri,
    dbName: process.env.MONGODB_DB || "muse_commons",
  });
  await dst.ready;
  const graphs = dst.collection("graphs");
  let n = 0;
  for (const { key, doc } of docs) {
    await graphs.put(key, doc);
    n++;
  }
  await dst.close();
  console.log(`migrate-to-mongo: upserted ${n} identity graph document(s) into MongoDB`);
  console.log("JSON files untouched. Rollback: unset MONGODB_URI (or STORE_BACKEND=json) and restart.");
  return { migrated: n, dryRun: false };
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("migrate-to-mongo failed:", err && err.message ? err.message : err);
      process.exit(1);
    }
  );
}

module.exports = { main };
