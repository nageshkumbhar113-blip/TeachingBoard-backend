-- D1 schema for the WhatsApp bot. Safe to run again (IF NOT EXISTS).

-- one row per child (GuestLead gid); `data` = the waFlow.js lead object as JSON
CREATE TABLE IF NOT EXISTS leads (
  gid        TEXT PRIMARY KEY,
  mobile     TEXT,
  name       TEXT,
  cls        TEXT,
  data       TEXT NOT NULL,
  crm        TEXT,                -- null | hot | cold | form | call | later | paid | closed
  next_due   INTEGER,             -- ms; when tick() should run next (null = nothing planned)
  last_in    INTEGER,             -- ms; the parent's last message
  revisit_at INTEGER,             -- ms; closed lead comes back in "next year" list
  lock_until INTEGER,             -- ms; a tiny per-lead lock (webhook vs cron)
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS leads_due    ON leads(next_due);
CREATE INDEX IF NOT EXISTS leads_crm    ON leads(crm, updated_at);
CREATE INDEX IF NOT EXISTS leads_mobile ON leads(mobile);

-- which child a WhatsApp number is talking about right now (one parent may have two children)
CREATE TABLE IF NOT EXISTS phones (
  mobile     TEXT PRIMARY KEY,
  gid        TEXT NOT NULL,
  updated_at INTEGER
);

-- chat + what happened (dir: in | out | push | app | team | log | do)
CREATE TABLE IF NOT EXISTS msgs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  gid    TEXT,
  mobile TEXT,
  dir    TEXT NOT NULL,
  kind   TEXT,
  cost   REAL DEFAULT 0,
  body   TEXT,
  wa_id  TEXT,
  status TEXT,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS msgs_gid  ON msgs(gid, at);
CREATE INDEX IF NOT EXISTS msgs_waid ON msgs(wa_id);
CREATE INDEX IF NOT EXISTS msgs_at   ON msgs(at);

-- WhatsApp message ids already handled (Meta may deliver a webhook twice)
CREATE TABLE IF NOT EXISTS seen (
  wa_id TEXT PRIMARY KEY,
  at    INTEGER NOT NULL
);

-- calls to Render that must happen even if Render is asleep (retried by the cron)
CREATE TABLE IF NOT EXISTS jobs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  gid     TEXT,
  action  TEXT NOT NULL,
  body    TEXT NOT NULL,
  tries   INTEGER DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_next ON jobs(next_at);

-- small settings / counters (last tick, last webhook, today's paid total)
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
