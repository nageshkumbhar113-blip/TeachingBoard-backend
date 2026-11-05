// Google Ads (YouTube ads) — for Admin › 📣 Ads › ▶️ YouTube.
//  • each ad's spend / views / clicks, keyed by our ad id (yt-…), read with GAQL;
//  • ⏸ / ▶ for one ad, +20% for a campaign budget (two presses in Admin);
//  • a "Lead" (first free test, or a teacher's registration) sent back as an offline click
//    conversion with Google's click id (gclid / gbraid / wbraid) — nothing personal.
// The ads themselves are made in Google Ads (YouTube video ads); our ad id is the ad's name and
// sits in its link (&ad=yt-…), which is how numbers are matched.
//
// Settings live only on the server (Render environment) — never in the browser or the chat:
//   GOOGLE_ADS_DEVELOPER_TOKEN   optional — Google retired developer tokens on 2026-09-09: API access now belongs to the
//                                Google Cloud project of the OAuth client (Test → apply for Basic there). Sent only if set.
//   GOOGLE_ADS_CLIENT_ID         OAuth client (Google Cloud project)
//   GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_REFRESH_TOKEN     OAuth refresh token of the Google account that runs the ads
//   GOOGLE_ADS_CUSTOMER_ID       the ads account, 123-456-7890 (dashes ok)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID optional: the manager (MCC) account the token was approved under
//   GOOGLE_ADS_LEAD_ACTION_ID    optional: conversion action (Import › clicks) for "Lead"
//   GOOGLE_ADS_API_VERSION       optional, default below — set it to the current version when connecting
//   GOOGLE_ADS_URL / GOOGLE_OAUTH_URL   tests only (local fakes)
const VERSION = 'v23';   // v23 is supported until about Feb 2027 — set GOOGLE_ADS_API_VERSION to the current one when connecting

const digits = s => String(s || '').replace(/\D/g, '');
const env = () => ({
  dev: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
  clientId: process.env.GOOGLE_ADS_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET || '',
  refresh: process.env.GOOGLE_ADS_REFRESH_TOKEN || '',
  customer: digits(process.env.GOOGLE_ADS_CUSTOMER_ID),
  login: digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
  leadAction: digits(process.env.GOOGLE_ADS_LEAD_ACTION_ID),
  base: `${(process.env.GOOGLE_ADS_URL || 'https://googleads.googleapis.com').replace(/\/$/, '')}/${process.env.GOOGLE_ADS_API_VERSION || VERSION}`,
  oauth: process.env.GOOGLE_OAUTH_URL || 'https://oauth2.googleapis.com/token',
});

function configured() {
  const e = env();
  return {
    ok: !!(e.clientId && e.clientSecret && e.refresh && e.customer),
    developer_token: !!e.dev, oauth: !!(e.clientId && e.clientSecret && e.refresh), customer: !!e.customer,
    manager: !!e.login, lead_action: !!e.leadAction, version: process.env.GOOGLE_ADS_API_VERSION || VERSION,
  };
}
const leadReady = () => configured().ok && !!env().leadAction;

let _tok = null, _tokUntil = 0;
async function _token() {
  if (_tok && Date.now() < _tokUntil) return _tok;
  const e = env();
  if (!configured().ok) { const err = new Error('Google Ads जोडलेलं नाही (Render मध्ये GOOGLE_ADS_* नाहीत)'); err.status = 400; throw err; }
  const res = await fetch(e.oauth, {
    method: 'POST',
    body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret, refresh_token: e.refresh, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) { const err = new Error(`Google login: ${body.error_description || body.error || res.statusText}`); err.status = 400; throw err; }
  _tok = body.access_token; _tokUntil = Date.now() + Math.max(60, (Number(body.expires_in) || 3600) - 120) * 1000;
  return _tok;
}
async function _call(path, payload) {
  const e = env();
  const headers = { Authorization: `Bearer ${await _token()}`, 'Content-Type': 'application/json' };
  if (e.dev) headers['developer-token'] = e.dev;   // no longer needed (access = the Cloud project), harmless while Google still accepts it
  if (e.login) headers['login-customer-id'] = e.login;
  const res = await fetch(`${e.base}/customers/${e.customer}${path}`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // never echo tokens: Google's message (and the first detailed error) is enough
    const det = body?.error?.details?.[0]?.errors?.[0]?.message;
    const err = new Error(`Google Ads: ${det || body?.error?.message || res.statusText}`);
    err.status = 400; throw err;
  }
  return body;
}
async function search(query) {
  const out = [];
  let pageToken;
  for (let i = 0; i < 20; i++) {
    const r = await _call('/googleAds:search', { query, ...(pageToken ? { pageToken } : {}) });
    out.push(...(r.results || []));
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return out;
}

const _day = d => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);   // IST date
const micros = m => (Number(m) || 0) / 1e6;
// our ad id: the ad's name if it looks like one, else &ad=… in its link
function adIdOf(ad = {}) {
  const n = String(ad.name || '').trim().toLowerCase();
  if (/^yt-[a-z0-9-]{2,40}$/.test(n)) return n;
  for (const u of [].concat(ad.finalUrls || [])) {
    const m = /[?&]ad=([a-z0-9-]{2,40})/i.exec(String(u));
    if (m) return m[1].toLowerCase();
  }
  return n;
}

async function account() {
  const r = await search('SELECT customer.descriptive_name, customer.currency_code, customer.id FROM customer LIMIT 1');
  const c = r[0]?.customer || {};
  return { id: String(c.id || env().customer), name: c.descriptiveName || '', currency: c.currencyCode || '' };
}

// GET numbers per ad for the last `days` days (+ every ad's state, also one with no spend yet)
let _cache = null, _cacheAt = 0, _cacheKey = '';
async function insights(days = 30) {
  const key = `${days}|${env().customer}|${env().refresh.slice(-6)}`;
  if (_cache && _cacheKey === key && Date.now() - _cacheAt < 10 * 60 * 1000) return _cache;
  const until = new Date(), since = new Date(Date.now() - (days - 1) * 864e5);
  // the budget can't be read FROM ad_group_ad — it comes FROM campaign (by campaign id)
  const [stats, state, camps] = await Promise.all([
    search(`SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.final_urls, metrics.cost_micros, metrics.impressions, metrics.video_trueview_views, metrics.clicks
            FROM ad_group_ad WHERE segments.date BETWEEN '${_day(since)}' AND '${_day(until)}'`),
    search(`SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.final_urls,
                   ad_group.id, ad_group.name, campaign.id, campaign.name, campaign.status
            FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'`),
    search(`SELECT campaign.id, campaign_budget.resource_name, campaign_budget.amount_micros
            FROM campaign WHERE campaign.status != 'REMOVED'`),
  ]);
  const budgetOf = new Map(camps.map(r => [String(r.campaign?.id || ''), r.campaignBudget || {}]));
  const by_name = {};
  for (const r of stats) {
    const id = adIdOf(r.adGroupAd?.ad);
    if (!id) continue;
    const o = by_name[id] = by_name[id] || { name: id, spend: 0, impressions: 0, views: 0, clicks: 0 };
    o.spend += micros(r.metrics?.costMicros); o.impressions += Number(r.metrics?.impressions) || 0;
    o.views += Number(r.metrics?.videoTrueviewViews ?? r.metrics?.videoViews) || 0;   // "video_views" became "video_trueview_views" in v22
    o.clicks += Number(r.metrics?.clicks) || 0;
  }
  for (const o of Object.values(by_name)) o.spend = Math.round(o.spend * 100) / 100;
  const ads = {};
  for (const r of state) {
    const id = adIdOf(r.adGroupAd?.ad);
    if (!id) continue;
    const b = budgetOf.get(String(r.campaign?.id || '')) || {};
    ads[id] = {
      ad: r.adGroupAd?.resourceName || '', status: r.adGroupAd?.status || '',
      adgroup: r.adGroup?.name || '', campaign: r.campaign?.name || '', campaign_id: String(r.campaign?.id || ''), campaign_status: r.campaign?.status || '',
      budget: micros(b.amountMicros), budget_id: b.resourceName || '',
    };
  }
  _cache = { since: _day(since), until: _day(until), by_name, ads }; _cacheAt = Date.now(); _cacheKey = key;
  return _cache;
}

// ⏸ / ▶ one ad (its resource name must be in this account)
async function setAdStatus(resourceName, on) {
  const rn = String(resourceName || '');
  if (!new RegExp(`^customers/${env().customer}/adGroupAds/\\d+~\\d+$`).test(rn)) throw Object.assign(new Error('Bad ad'), { status: 400 });
  await _call('/adGroupAds:mutate', { operations: [{ update: { resourceName: rn, status: on ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' }] });
  _cache = null;
  return { status: on ? 'ENABLED' : 'PAUSED' };
}
// +20% (at most) on a campaign's daily budget
async function raiseBudget(budgetResource) {
  const rn = String(budgetResource || '');
  if (!new RegExp(`^customers/${env().customer}/campaignBudgets/\\d+$`).test(rn)) throw Object.assign(new Error('Bad budget'), { status: 400 });
  const r = await search(`SELECT campaign_budget.amount_micros, campaign_budget.name FROM campaign_budget WHERE campaign_budget.resource_name = '${rn}'`);
  const cur = Number(r[0]?.campaignBudget?.amountMicros) || 0;
  if (!cur) throw Object.assign(new Error('Budget सापडलं नाही'), { status: 400 });
  const next = Math.round(cur * 1.2 / 10000) * 10000;   // whole paise
  await _call('/campaignBudgets:mutate', { operations: [{ update: { resourceName: rn, amountMicros: String(next) }, updateMask: 'amount_micros' }] });
  _cache = null;
  return { name: r[0]?.campaignBudget?.name || '', from: Math.round(micros(cur)), to: Math.round(micros(next)) };
}

// a "Lead" back to Google (offline click conversion). click = { gclid } | { gbraid } | { wbraid }
async function sendLead(click, at = new Date()) {
  if (!leadReady()) return { skipped: 'not-configured' };
  const ids = ['gclid', 'gbraid', 'wbraid'].filter(k => click?.[k]);
  if (!ids.length) return { skipped: 'no-click-id' };
  const e = env();
  const ist = new Date(at.getTime() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + '+05:30';
  const conv = { conversionAction: `customers/${e.customer}/conversionActions/${e.leadAction}`, conversionDateTime: ist, [ids[0]]: String(click[ids[0]]).slice(0, 300) };
  const r = await _call(':uploadClickConversions', { conversions: [conv], partialFailure: true });
  if (r.partialFailureError?.message) throw Object.assign(new Error(`Google Ads: ${r.partialFailureError.message}`), { status: 400 });
  return { sent: true };
}
const clickOf = body => {
  const out = {};
  for (const k of ['gclid', 'gbraid', 'wbraid']) { const v = String(body?.[k] || '').trim(); if (/^[A-Za-z0-9_\-.~]{10,300}$/.test(v)) out[k] = v; }
  return out;
};

module.exports = { configured, leadReady, account, insights, search, setAdStatus, raiseBudget, sendLead, clickOf, adIdOf, _resetCache: () => { _cache = null; _tok = null; } };
