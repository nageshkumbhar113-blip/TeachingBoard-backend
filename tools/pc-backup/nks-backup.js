#!/usr/bin/env node
/*
 * NKs EduOrbit — automatic database backup on the owner's computer.
 *
 * Reads MongoDB Atlas with a READ-ONLY user (never writes there) and keeps copies in a folder
 * (default F:\NKs-Backup):
 *   month\YYYY-MM-DD\   a real full copy downloaded from Atlas (first run, then once a month)
 *   daily\YYYY-MM-DD\   only what changed since the last run + the ids that were deleted
 *   week\YYYY-MM-DD\    every Sunday: a full copy built ON THIS COMPUTER (last full + the dailies),
 *                       nothing extra is downloaded
 *   backup-log.txt      one line per run
 * Keeps: daily 14 days, week 4 weeks, month 12 months (a daily is removed only when a newer full
 * copy covers it). Files are gzip'd EJSON lines (types such as dates and ids are kept exactly).
 *
 * Commands:
 *   node nks-backup.js                    backup (once a day; a second run the same day does nothing)
 *   node nks-backup.js status             what is in the folder
 *   node nks-backup.js restore --date YYYY-MM-DD [--to mongodb://127.0.0.1:27999/check]
 *        rebuilds the data as it was on that date into <folder>\restore\<date>\ and, with --to,
 *        loads it into a LOCAL database to look at (never into Atlas).
 * Options: --dir <folder>  --env <file with MONGODB_URI=...>  --today YYYY-MM-DD (tests only)
 * The Atlas address with its password lives only in <folder>\backup.env (MONGODB_URI=...).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { MongoClient, BSON } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongodb'));
const { EJSON, ObjectId } = BSON;

const KEEP = { daily: 14, week: 28, month: 365 };   // days
const SMALL = 20000;            // a collection without a change time and at most this many rows is copied whole every day
const MARGIN_MS = 10 * 60000;   // re-read the last 10 minutes of changes (a row written twice is harmless)

// ── arguments / config ──
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'backup';
const DIR = path.resolve(opt('dir') || 'F:\\NKs-Backup');
const ENV_FILE = opt('env') || path.join(DIR, 'backup.env');

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = opt('today') || ymd(new Date());
const dayNum = s => Math.round(new Date(s + 'T00:00:00Z').getTime() / 864e5);
const weekday = s => new Date(s + 'T00:00:00Z').getUTCDay();   // 0 = Sunday

function log(line) {
  const stamp = `${TODAY} ${new Date().toTimeString().slice(0, 5)}`;
  const text = `${stamp}  ${line}`;
  console.log(text);
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(path.join(DIR, 'backup-log.txt'), text + '\r\n'); } catch { /* the console line is enough */ }
}

// ── files ──
const key = id => EJSON.stringify(id, { relaxed: false });

async function writeLines(file, docs) {
  // docs: async iterable or array; returns the number of lines written
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(file + '.part');
  gz.pipe(out);
  let n = 0;
  for await (const d of docs) {
    if (!gz.write(EJSON.stringify(d, { relaxed: false }) + '\n')) await new Promise(r => gz.once('drain', r));
    n++;
  }
  gz.end();
  await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); gz.on('error', rej); });
  await fs.promises.rename(file + '.part', file);
  return n;
}

async function* readLines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield EJSON.parse(line, { relaxed: false });
}

async function countLines(file) { let n = 0; for await (const _ of readLines(file)) n++; return n; }   // eslint-disable-line no-unused-vars

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.part', JSON.stringify(v, null, 1)); fs.renameSync(f + '.part', f); };

// every finished copy: [{kind, date, dir, manifest}] sorted by date (a full before a daily on the same day)
function copies() {
  const out = [];
  for (const kind of ['month', 'week', 'daily']) {
    const base = path.join(DIR, kind);
    if (!fs.existsSync(base)) continue;
    for (const date of fs.readdirSync(base)) {
      const m = path.join(base, date, 'manifest.json');
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && fs.existsSync(m)) {
        const manifest = readJson(m);
        if (manifest.ok) out.push({ kind, date, dir: path.join(base, date), manifest });
      }
    }
  }
  const rank = { month: 0, week: 1, daily: 2 };
  return out.sort((a, b) => a.date.localeCompare(b.date) || rank[a.kind] - rank[b.kind]);
}
const isFull = c => c.kind === 'month' || c.kind === 'week';

// ── state on this computer ──
const STATE = () => path.join(DIR, 'state', 'state.json');
const IDS = name => path.join(DIR, 'state', 'ids', name + '.gz');
function loadState() { return fs.existsSync(STATE()) ? readJson(STATE()) : { collections: {} }; }

async function saveIds(name, ids) {
  await fs.promises.mkdir(path.dirname(IDS(name)), { recursive: true });
  await fs.promises.writeFile(IDS(name) + '.part', zlib.gzipSync(EJSON.stringify(ids, { relaxed: false })));
  await fs.promises.rename(IDS(name) + '.part', IDS(name));
}
async function loadIds(name) {
  if (!fs.existsSync(IDS(name))) return null;
  return EJSON.parse(zlib.gunzipSync(await fs.promises.readFile(IDS(name))).toString('utf8'), { relaxed: false });
}

// ── Atlas ──
async function connect() {
  const env = readEnv(ENV_FILE);
  const uri = process.env.NKS_BACKUP_URI || env.MONGODB_URI;
  if (!uri) throw new Error(`MONGODB_URI सापडला नाही — ${ENV_FILE} मध्ये MONGODB_URI=... लिहा`);
  const client = new MongoClient(uri, { readPreference: 'secondaryPreferred', serverSelectionTimeoutMS: 30000, appName: 'nks-pc-backup' });
  await client.connect();
  return { client, dbName: process.env.NKS_BACKUP_DB || env.DB_NAME || undefined };
}
async function serverNow(db) {
  const h = await db.admin().command({ hello: 1 }).catch(() => null);
  return h?.localTime ? new Date(h.localTime) : new Date();
}
async function collectionNames(db) {
  return (await db.listCollections({}, { nameOnly: true }).toArray())
    .filter(c => c.type !== 'view' && !c.name.startsWith('system.')).map(c => c.name).sort();
}
async function timeField(col) {
  for (const f of ['updated_at', 'updatedAt']) if (await col.findOne({ [f]: { $exists: true } }, { projection: { _id: 1 } })) return f;
  return null;
}
async function allIds(col) {
  const ids = [];
  for await (const d of col.find({}, { projection: { _id: 1 } })) ids.push(d._id);
  return ids;
}
const maxObjectId = ids => ids.reduce((m, id) => (id instanceof ObjectId && (!m || id.toHexString() > m.toHexString()) ? id : m), null);

// ── a real full copy from Atlas ──
async function fullFromAtlas(db, now) {
  const dir = path.join(DIR, 'month', TODAY);
  const state = { collections: {}, since: now.toISOString() };
  const manifest = { kind: 'month', date: TODAY, started: new Date().toISOString(), collections: {} };
  let total = 0;
  for (const name of await collectionNames(db)) {
    const col = db.collection(name);
    const n = await writeLines(path.join(dir, name + '.gz'), col.find({}).sort({ _id: 1 }));
    const back = await countLines(path.join(dir, name + '.gz'));
    if (back !== n) throw new Error(`${name}: लिहिलेल्या ${n}, वाचल्या ${back}`);
    const ids = await allIds(col);
    await saveIds(name, ids);
    state.collections[name] = { tf: await timeField(col), maxId: maxObjectId(ids)?.toHexString() || null };
    manifest.collections[name] = { docs: n };
    total += n;
  }
  manifest.finished = new Date().toISOString();
  manifest.total = total;
  manifest.ok = true;
  writeJson(path.join(dir, 'manifest.json'), manifest);
  writeJson(STATE(), state);
  return { total, count: Object.keys(manifest.collections).length };
}

// ── only what changed ──
async function dailyFromAtlas(db, now, state) {
  const dir = path.join(DIR, 'daily', TODAY);
  const since = new Date(new Date(state.since).getTime() - MARGIN_MS);
  const manifest = { kind: 'daily', date: TODAY, since: since.toISOString(), started: new Date().toISOString(), collections: {} };
  const next = { collections: {}, since: now.toISOString() };
  let changed = 0, deleted = 0;
  for (const name of await collectionNames(db)) {
    const col = db.collection(name);
    const prev = state.collections[name];
    const tf = prev?.tf || await timeField(col);
    const ids = await allIds(col);
    const maxId = maxObjectId(ids);
    let mode, filter;
    if (!prev) { mode = 'full'; filter = {}; }                       // a new collection: copy it whole
    else if (tf) {
      mode = 'delta';
      filter = prev.maxId ? { $or: [{ [tf]: { $gte: since } }, { _id: { $gt: new ObjectId(prev.maxId) } }] } : { [tf]: { $gte: since } };
    } else if (ids.length <= SMALL) { mode = 'full'; filter = {}; }
    else { mode = 'delta'; filter = prev.maxId ? { _id: { $gt: new ObjectId(prev.maxId) } } : {}; }

    const file = path.join(dir, name + '.gz');
    const n = await writeLines(file, col.find(filter).sort({ _id: 1 }));
    if ((await countLines(file)) !== n) throw new Error(`${name}: file तपासणी चुकली`);
    let gone = [];
    if (mode === 'delta') {
      const old = await loadIds(name);
      if (old) { const now = new Set(ids.map(key)); gone = old.filter(id => !now.has(key(id))); }
      if (gone.length) await writeLines(path.join(dir, name + '.deleted.gz'), gone);
    }
    await saveIds(name, ids);
    next.collections[name] = { tf, maxId: maxId?.toHexString() || prev?.maxId || null };
    manifest.collections[name] = { mode, docs: n, deleted: gone.length };
    changed += mode === 'delta' ? n : 0;
    deleted += gone.length;
  }
  // a collection that disappeared from Atlas
  for (const name of Object.keys(state.collections)) if (!manifest.collections[name]) manifest.collections[name] = { mode: 'dropped', docs: 0, deleted: 0 };
  manifest.finished = new Date().toISOString();
  manifest.ok = true;
  writeJson(path.join(dir, 'manifest.json'), manifest);
  writeJson(STATE(), next);
  return { changed, deleted, whole: Object.values(manifest.collections).filter(c => c.mode === 'full').length };
}

// ── rebuild: the last full copy up to <date> + the dailies after it ──
async function buildAsOf(date, outDir, kind) {
  const all = copies().filter(c => c.date <= date);
  const base = [...all].reverse().find(isFull);
  if (!base) throw new Error(`${date} पूर्वीची पूर्ण copy नाही`);
  const dailies = all.filter(c => c.kind === 'daily' && c.date > base.date);
  const names = new Set(Object.keys(base.manifest.collections));
  for (const d of dailies) for (const [n, c] of Object.entries(d.manifest.collections)) c.mode === 'dropped' ? names.delete(n) : names.add(n);
  const manifest = { kind, date, built_from: [base.kind + '/' + base.date, ...dailies.map(d => 'daily/' + d.date)], started: new Date().toISOString(), collections: {} };
  let total = 0;
  for (const name of [...names].sort()) {
    const rows = new Map();
    const baseFile = path.join(base.dir, name + '.gz');
    if (fs.existsSync(baseFile)) for await (const d of readLines(baseFile)) rows.set(key(d._id), d);
    for (const d of dailies) {
      const c = d.manifest.collections[name];
      if (!c) continue;
      if (c.mode === 'dropped') { rows.clear(); continue; }
      if (c.mode === 'full') rows.clear();
      const f = path.join(d.dir, name + '.gz');
      if (fs.existsSync(f)) for await (const doc of readLines(f)) rows.set(key(doc._id), doc);
      const del = path.join(d.dir, name + '.deleted.gz');
      if (fs.existsSync(del)) for await (const id of readLines(del)) rows.delete(key(id));
    }
    const sorted = [...rows.values()].sort((a, b) => (key(a._id) < key(b._id) ? -1 : 1));
    const n = await writeLines(path.join(outDir, name + '.gz'), sorted);
    manifest.collections[name] = { docs: n };
    total += n;
  }
  manifest.total = total;
  manifest.finished = new Date().toISOString();
  manifest.ok = true;
  writeJson(path.join(outDir, 'manifest.json'), manifest);
  return { total, base: base.kind + '/' + base.date, dailies: dailies.length };
}

// ── keep only what is needed ──
function prune() {
  const list = copies();
  const fulls = list.filter(isFull);
  const newestFull = fulls[fulls.length - 1];
  const removed = [];
  for (const c of list) {
    const age = dayNum(TODAY) - dayNum(c.date);
    if (age <= KEEP[c.kind]) continue;
    if (c === newestFull) continue;                                       // never the last full copy
    if (c.kind === 'daily' && !fulls.some(f => f.date >= c.date)) continue; // still needed to rebuild
    if (c.kind === 'week' && !list.some(f => isFull(f) && f.date > c.date)) continue;
    fs.rmSync(c.dir, { recursive: true, force: true });
    removed.push(`${c.kind}/${c.date}`);
  }
  // old restore folders (made by "restore") after 7 days
  const rdir = path.join(DIR, 'restore');
  if (fs.existsSync(rdir)) for (const d of fs.readdirSync(rdir)) {
    const st = fs.statSync(path.join(rdir, d));
    if (Date.now() - st.mtimeMs > 7 * 864e5) { fs.rmSync(path.join(rdir, d), { recursive: true, force: true }); removed.push('restore/' + d); }
  }
  return removed;
}

const fmtN = n => Number(n).toLocaleString('en-IN');
function folderMB(dir) {
  let s = 0;
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : (s += fs.statSync(path.join(d, f.name)).size); };
  if (fs.existsSync(dir)) walk(dir);
  return (s / 1048576).toFixed(1);
}

// ── commands ──
async function backup() {
  fs.mkdirSync(DIR, { recursive: true });
  const lock = path.join(DIR, 'state', 'running.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 3 * 3600e3) { console.log('दुसरा backup चालू आहे'); return; }
  const list = copies();
  if (list.some(c => c.date === TODAY && (c.kind === 'daily' || c.kind === 'month'))) { console.log(`आजचा (${TODAY}) backup आधीच झाला आहे`); return; }
  fs.writeFileSync(lock, String(process.pid));
  let client;
  try {
    const c = await connect();
    client = c.client;
    const db = client.db(c.dbName);
    if (!(await collectionNames(db)).length) throw new Error(`database "${db.databaseName}" रिकामा आहे — backup.env मध्ये DB_NAME=... लिहा`);
    const now = await serverNow(db);
    const state = loadState();
    const months = list.filter(c => c.kind === 'month');
    const lastMonth = months[months.length - 1];
    const needFull = !state.since || !lastMonth || TODAY.slice(0, 7) !== lastMonth.date.slice(0, 7) || !list.some(isFull);
    if (needFull) {
      const r = await fullFromAtlas(db, now);
      log(`✅ पूर्ण backup (महिन्याचा): ${r.count} भाग, ${fmtN(r.total)} नोंदी → month\\${TODAY}`);
    } else {
      const r = await dailyFromAtlas(db, now, state);
      log(`✅ रोजचा backup: नवीन/बदललेल्या ${fmtN(r.changed)} नोंदी, delete झालेल्या ${fmtN(r.deleted)}, पूर्ण copy केलेले लहान भाग ${r.whole} → daily\\${TODAY}`);
      if (weekday(TODAY) === 0 && !fs.existsSync(path.join(DIR, 'week', TODAY, 'manifest.json'))) {
        const w = await buildAsOf(TODAY, path.join(DIR, 'week', TODAY), 'week');
        log(`✅ रविवारची पूर्ण copy (computer वर बनवली): ${fmtN(w.total)} नोंदी (${w.base} + ${w.dailies} रोजचे) → week\\${TODAY}`);
      }
    }
    const removed = prune();
    if (removed.length) log(`🧹 जुने backup काढले: ${removed.join(', ')}`);
    log(`📦 Backup folder: ${folderMB(DIR)} MB`);
  } catch (err) {
    log(`❌ Backup झाला नाही: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client?.close().catch(() => {});
    fs.rmSync(lock, { force: true });
  }
}

function status() {
  const list = copies();
  if (!list.length) { console.log('अजून एकही backup नाही'); return; }
  for (const kind of ['month', 'week', 'daily']) {
    const l = list.filter(c => c.kind === kind);
    console.log(`${kind.padEnd(6)} ${String(l.length).padStart(3)}  ${l.map(c => c.date).join(' ')}`);
  }
  console.log(`folder: ${DIR}  (${folderMB(DIR)} MB)`);
}

async function restore() {
  const date = opt('date') || TODAY;
  const out = path.join(DIR, 'restore', date);
  fs.rmSync(out, { recursive: true, force: true });
  const r = await buildAsOf(date, out, 'restore');
  console.log(`✅ ${date} चा data तयार: ${fmtN(r.total)} नोंदी (${r.base} + ${r.dailies} रोजचे) → ${out}`);
  const to = opt('to');
  if (!to) return;
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(to)) throw new Error('--to फक्त या computer वरच्या database साठी (mongodb://127.0.0.1:.../नाव). Atlas मध्ये थेट restore नाही.');
  const client = new MongoClient(to);
  await client.connect();
  try {
    const db = client.db();
    const m = readJson(path.join(out, 'manifest.json'));
    for (const name of Object.keys(m.collections)) {
      const col = db.collection(name);
      await col.deleteMany({});
      let batch = [];
      for await (const d of readLines(path.join(out, name + '.gz'))) {
        batch.push(d);
        if (batch.length === 1000) { await col.insertMany(batch, { ordered: false }); batch = []; }
      }
      if (batch.length) await col.insertMany(batch, { ordered: false });
    }
    console.log(`✅ ${to} मध्ये भरला`);
  } finally { await client.close(); }
}

(async () => {
  if (cmd === 'backup') await backup();
  else if (cmd === 'status') status();
  else if (cmd === 'restore') await restore();
  else { console.log('commands: backup | status | restore --date YYYY-MM-DD [--to mongodb://127.0.0.1:27999/name]'); process.exitCode = 2; }
})().catch(err => { console.error('❌', err.message); process.exitCode = 1; });
