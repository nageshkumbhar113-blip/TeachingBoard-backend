// Meta (Facebook / Instagram) Marketing API — read-only for now: the ad account and
// each ad's spend / impressions / link clicks, for Admin › Sync › Ads.
//
// Settings live only on the server (Render environment):
//   META_ACCESS_TOKEN   system-user token (ads_read, ads_management, …)
//   META_AD_ACCOUNT_ID  act_<number>
//   META_APP_SECRET     app secret — every call carries appsecret_proof, so the token alone is useless
//   META_PAGE_ID        the Facebook Page the ads run as (used when ads are created, phase 2)
//   META_API_VERSION    optional, default v23.0
//   META_GRAPH_URL      optional, tests only (a local fake Graph API)
// The token never leaves the server: the admin's browser only gets the numbers.
const { createHmac } = require('crypto');

const env = () => ({
  token: process.env.META_ACCESS_TOKEN || '',
  account: (() => { const a = String(process.env.META_AD_ACCOUNT_ID || '').trim(); return !a ? '' : a.startsWith('act_') ? a : `act_${a}`; })(),
  secret: process.env.META_APP_SECRET || '',
  page: process.env.META_PAGE_ID || '',
  base: `${(process.env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '')}/${process.env.META_API_VERSION || 'v23.0'}`,
});

function configured() {
  const e = env();
  return { ok: !!(e.token && e.account), token: !!e.token, account: !!e.account, secret: !!e.secret, page: !!e.page };
}

async function graph(path, params = {}) {
  const e = env();
  if (!e.token || !e.account) { const err = new Error('Meta जोडलेलं नाही (Render मध्ये META_ACCESS_TOKEN / META_AD_ACCOUNT_ID नाही)'); err.status = 400; throw err; }
  const q = new URLSearchParams({ ...params, access_token: e.token });
  if (e.secret) q.set('appsecret_proof', createHmac('sha256', e.secret).update(e.token).digest('hex'));
  const res = await fetch(`${e.base}/${path}?${q}`, { signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    // never echo the token back: Meta's message is enough
    const err = new Error(`Meta: ${body.error?.message || res.statusText || 'request failed'}`);
    err.status = 502; err.code = body.error?.code;
    throw err;
  }
  return body;
}

// all pages of a list (insights can be paged)
async function graphAll(path, params) {
  const out = [];
  let body = await graph(path, params), guard = 0;
  out.push(...(body.data || []));
  while (body.paging?.cursors?.after && body.paging?.next && guard++ < 20) {
    body = await graph(path, { ...params, after: body.paging.cursors.after });
    out.push(...(body.data || []));
  }
  return out;
}

async function account() {
  const e = env();
  const a = await graph(e.account, { fields: 'name,account_status,currency,amount_spent,timezone_name' });
  return { id: a.id, name: a.name, status: a.account_status, currency: a.currency, timezone: a.timezone_name };
}

const _ist = d => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
// per-ad numbers for the last `days` days, keyed by the ad's name (our ad id) in lower case
let _cache = null;
async function insights(days = 30) {
  const key = String(days);
  if (_cache && _cache.key === key && Date.now() - _cache.at < 10 * 60e3) return _cache.data;   // ≤ 1 Meta call / 10 min
  const e = env();
  const until = new Date(), since = new Date(Date.now() - (days - 1) * 864e5);
  const rows = await graphAll(`${e.account}/insights`, {
    level: 'ad',
    fields: 'ad_id,ad_name,adset_name,campaign_name,spend,impressions,reach,inline_link_clicks',
    time_range: JSON.stringify({ since: _ist(since), until: _ist(until) }),
    limit: '500',
  });
  const byName = {};
  for (const r of rows) {
    const k = String(r.ad_name || '').trim().toLowerCase();
    if (!k) continue;
    const t = byName[k] = byName[k] || { name: r.ad_name, spend: 0, impressions: 0, reach: 0, clicks: 0, ads: 0, campaign: r.campaign_name || '', adset: r.adset_name || '' };
    t.spend += Number(r.spend) || 0;
    t.impressions += Number(r.impressions) || 0;
    t.reach += Number(r.reach) || 0;
    t.clicks += Number(r.inline_link_clicks) || 0;
    t.ads++;
  }
  for (const t of Object.values(byName)) t.spend = Math.round(t.spend * 100) / 100;
  const data = { days, since: _ist(since), until: _ist(until), by_name: byName, fetched_at: new Date().toISOString() };
  _cache = { key, at: Date.now(), data };
  return data;
}

module.exports = { configured, account, insights, graph, _resetCache: () => { _cache = null; } };
