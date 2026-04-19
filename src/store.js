/* ════════════════════════════════════════
   store.js — JSON file-based data store
   All collections live under /data/*.json
════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function _file(collection) {
  return path.join(DATA_DIR, `${collection}.json`);
}

function _read(collection) {
  const file = _file(collection);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function _write(collection, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(_file(collection), JSON.stringify(data, null, 2), 'utf8');
}

function getAll(collection) {
  return _read(collection);
}

function getById(collection, id) {
  return _read(collection).find(item => item.id === id) || null;
}

function getBy(collection, key, value) {
  return _read(collection).find(item => item[key] === value) || null;
}

function insert(collection, record) {
  const rows = _read(collection);
  rows.push(record);
  _write(collection, rows);
  return record;
}

/** Insert or replace by record.id */
function upsert(collection, record) {
  const rows  = _read(collection);
  const idx   = rows.findIndex(r => r.id === record.id);
  if (idx >= 0) rows[idx] = record;
  else rows.push(record);
  _write(collection, rows);
  return record;
}

/** Update fields by id; returns updated record or null */
function update(collection, id, fields) {
  const rows = _read(collection);
  const idx  = rows.findIndex(r => r.id === id);
  if (idx < 0) return null;
  rows[idx] = { ...rows[idx], ...fields };
  _write(collection, rows);
  return rows[idx];
}

function remove(collection, id) {
  const rows     = _read(collection);
  const filtered = rows.filter(r => r.id !== id);
  _write(collection, filtered);
  return rows.length !== filtered.length;
}

module.exports = { getAll, getById, getBy, insert, upsert, update, remove };
