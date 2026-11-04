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

function _auth() {
  const e = env();
  if (!e.token || !e.account) { const err = new Error('Meta जोडलेलं नाही (Render मध्ये META_ACCESS_TOKEN / META_AD_ACCOUNT_ID नाही)'); err.status = 400; throw err; }
  const a = { access_token: e.token };
  if (e.secret) a.appsecret_proof = createHmac('sha256', e.secret).update(e.token).digest('hex');
  return a;
}
async function _done(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    // never echo the token back: Meta's message is enough
    const m = body.error?.error_user_msg || body.error?.message || res.statusText || 'request failed';
    const err = new Error(`Meta: ${m}`);
    err.status = 400; err.code = body.error?.code;
    throw err;
  }
  return body;
}
// objects / arrays go to Meta as JSON strings
const _form = params => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));

async function graph(path, params = {}) {
  const q = new URLSearchParams({ ..._form(params), ..._auth() });
  return _done(await fetch(`${env().base}/${path}?${q}`, { signal: AbortSignal.timeout(20000) }));
}
async function post(path, params = {}) {
  const body = new URLSearchParams({ ..._form(params), ..._auth() });
  return _done(await fetch(`${env().base}/${path}`, { method: 'POST', body, signal: AbortSignal.timeout(60000) }));
}
async function postFile(path, params, field, buf, filename, type) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ..._form(params), ..._auth() })) fd.append(k, v);
  fd.append(field, new Blob([buf], { type }), filename);
  return _done(await fetch(`${env().base}/${path}`, { method: 'POST', body: fd, signal: AbortSignal.timeout(180000) }));
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

// ── phase 2: make an ad in Meta, always PAUSED (the admin checks it in Ads Manager and turns it on) ──
const AUDIENCE = {
  parent:  { campaign: 'EduOrbit · Parents',        age_min: 28, age_max: 50 },
  student: { campaign: 'EduOrbit · Students',       age_min: 13, age_max: 17 },
  school:  { campaign: 'EduOrbit · School teachers', age_min: 22, age_max: 55 },
  youtube: { campaign: 'EduOrbit · YouTube teachers', age_min: 20, age_max: 50 },
};
let _region = null;
async function _maharashtra() {
  if (_region) return _region;
  const r = await graph('search', { type: 'adgeolocation', location_types: ['region'], q: 'Maharashtra', country_code: 'IN', limit: 5 });
  const hit = (r.data || []).find(x => /maharashtra/i.test(x.name)) || null;
  _region = hit ? { key: String(hit.key) } : null;
  return _region;
}
async function _findByName(edge, name, fields = 'id,name,status') {
  const r = await graph(`${env().account}/${edge}`, { fields, filtering: [{ field: 'name', operator: 'EQUAL', value: name }], limit: 5 });
  return (r.data || []).find(x => x.name === name) || null;
}
async function uploadVideo(buf, name) {
  const r = await postFile(`${env().account}/advideos`, { name }, 'source', buf, `${name}.mp4`, 'video/mp4');
  return { video_id: r.id };
}
async function uploadImage(buf) {
  const r = await post(`${env().account}/adimages`, { bytes: Buffer.from(buf).toString('base64') });
  const img = Object.values(r.images || {})[0];
  if (!img?.hash) throw Object.assign(new Error('Meta: thumbnail upload failed'), { status: 400 });
  return { image_hash: img.hash };
}
async function _videoReady(id, waitMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const v = await graph(id, { fields: 'status' }).catch(() => null);
    const s = v?.status?.video_status;
    if (s === 'ready') return true;
    if (s === 'error') throw Object.assign(new Error('Meta: video processing failed'), { status: 400 });
    if (Date.now() - t0 > waitMs) return false;
    await new Promise(r => setTimeout(r, Number(process.env.META_POLL_MS) || 4000));
  }
}
// { name, audience, adset, daily_budget (₹), video_id, image_hash, message, headline, cta, link }
async function createAd(o) {
  const e = env();
  if (!e.page) throw Object.assign(new Error('Render मध्ये META_PAGE_ID नाही'), { status: 400 });
  const A = AUDIENCE[o.audience];
  if (!A) throw Object.assign(new Error('Unknown audience'), { status: 400 });
  const existing = await _findByName('ads', o.name);
  if (existing) return { exists: true, ad_id: existing.id, status: existing.status };

  let campaign = await _findByName('campaigns', A.campaign);
  if (!campaign) campaign = await post(`${e.account}/campaigns`, {
    name: A.campaign, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false,
  });
  let adset = await _findByName('adsets', o.adset);
  if (!adset) {
    const region = await _maharashtra();
    adset = await post(`${e.account}/adsets`, {
      name: o.adset, campaign_id: campaign.id, status: 'PAUSED',
      daily_budget: Math.max(100, Math.round(Number(o.daily_budget) || 0)) * 100,   // paise
      billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', destination_type: 'WEBSITE',
      targeting: {
        geo_locations: region ? { regions: [region], location_types: ['home', 'recent'] } : { countries: ['IN'] },
        // the admin's ages (Admin › Ads), else the audience's
        age_min: o.age_min || A.age_min, age_max: o.age_max || A.age_max,
        targeting_automation: { advantage_audience: 0 },
      },
    });
  }
  const ready = await _videoReady(o.video_id);
  if (!ready) return { pending: true, campaign_id: campaign.id, adset_id: adset.id };
  const creative = await post(`${e.account}/adcreatives`, {
    name: o.name,
    object_story_spec: {
      page_id: e.page,
      ...(process.env.META_IG_ACTOR_ID ? { instagram_user_id: process.env.META_IG_ACTOR_ID } : {}),
      video_data: {
        video_id: o.video_id, image_hash: o.image_hash, message: o.message, title: o.headline,
        call_to_action: { type: o.cta === 'SIGN_UP' ? 'SIGN_UP' : 'LEARN_MORE', value: { link: o.link } },
      },
    },
  });
  const ad = await post(`${e.account}/ads`, { name: o.name, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED' });
  return { created: true, ad_id: ad.id, adset_id: adset.id, campaign_id: campaign.id, creative_id: creative.id,
    manager: `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${e.account.replace(/^act_/, '')}&selected_ad_ids=${ad.id}` };
}

module.exports = { configured, account, insights, graph, uploadVideo, uploadImage, createAd, _resetCache: () => { _cache = null; _region = null; } };
