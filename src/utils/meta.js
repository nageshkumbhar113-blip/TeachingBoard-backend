// Meta (Facebook / Instagram) Marketing API — read-only for now: the ad account and
// each ad's spend / impressions / link clicks, for Admin › Sync › Ads.
//
// Settings live only on the server (Render environment):
//   META_ACCESS_TOKEN   system-user token (ads_read, ads_management, …)
//   META_AD_ACCOUNT_ID  act_<number>
//   META_APP_SECRET     app secret — every call carries appsecret_proof, so the token alone is useless
//   META_PAGE_ID        the Facebook Page the ads run as (used when ads are created, phase 2)
//   META_API_VERSION    optional, default v26.0 (Marketing API versions retire faster than Graph — keep it recent)
//   META_GRAPH_URL      optional, tests only (a local fake Graph API)
// The token never leaves the server: the admin's browser only gets the numbers.
const { createHmac } = require('crypto');

const env = () => ({
  token: process.env.META_ACCESS_TOKEN || '',
  account: (() => { const a = String(process.env.META_AD_ACCOUNT_ID || '').trim(); return !a ? '' : a.startsWith('act_') ? a : `act_${a}`; })(),
  secret: process.env.META_APP_SECRET || '',
  page: process.env.META_PAGE_ID || '',
  base: `${(process.env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '')}/${process.env.META_API_VERSION || 'v26.0'}`,
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
    // the common set-up problems, said plainly (Meta's own words stay at the end)
    const hint = /development mode|must be in public/i.test(m) ? 'Meta app अजून Development mode मध्ये आहे — developers.facebook.com › तुमचं app › Publish (Live) करा, मग पुन्हा पाठवा. ' : '';
    const err = new Error(`${hint}Meta: ${m}`);
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
  const a = await graph(e.account, { fields: 'name,account_status,currency,amount_spent,timezone_name,balance,spend_cap,is_prepay_account,funding_source_details' });
  // money fields come in the smallest unit (paise); the prepaid balance only as Meta's own text
  const rupees = v => (v === undefined || v === null || v === '' ? null : Number(v) / 100);
  const fs0 = a.funding_source_details || {};
  // "Available balance (₹1,234.50 INR)" → 1234.5
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(String(fs0.display_string || ''));
  return {
    id: a.id, name: a.name, status: a.account_status, currency: a.currency, timezone: a.timezone_name,
    spent_total: rupees(a.amount_spent), due: rupees(a.balance), spend_cap: Number(a.spend_cap) ? rupees(a.spend_cap) : null,
    prepay: !!a.is_prepay_account, funds_text: String(fs0.display_string || ''),
    funds: a.is_prepay_account && m ? Number(m[1].replace(/,/g, '')) : null,
  };
}

const _ist = d => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
// per-ad numbers for the last `days` days, keyed by the ad's name (our ad id) in lower case
let _cache = null;
async function insights(days = 30) {
  const key = `${days}|${env().account}|${env().token.slice(-6)}`;   // new account / token = fresh numbers
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
  const data = { days, since: _ist(since), until: _ist(until), by_name: byName, ads: await adsState(), fetched_at: new Date().toISOString() };
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
// 📍 area groups (NMMS: where most of the state's NMMS students register — the admin's district table,
// 2025: the 6 districts of group A = 44% of 2,48,758). Each town + a 40 km circle. Pune city too
// (2026-11-07, the admin: many aware parents and ZP / corporation schools there).
// A town may be known to Meta by an old name — every name is tried.
const GEO = {
  gata: [['Kolhapur'], ['Ichalkaranji'], ['Gadhinglaj'], ['Sangli'], ['Miraj'], ['Islampur'], ['Satara'], ['Karad'], ['Phaltan'], ['Solapur'], ['Pandharpur'], ['Barshi'],
    ['Ahilyanagar', 'Ahmednagar'], ['Shrirampur'], ['Sangamner'], ['Pune'], ['Pimpri-Chinchwad', 'Pimpri'], ['Baramati'], ['Indapur'], ['Shirur'], ['Junnar'], ['Daund']],
  marathwada: [['Chhatrapati Sambhajinagar', 'Aurangabad'], ['Beed'], ['Ambajogai'], ['Latur'], ['Udgir'], ['Nanded'], ['Dharashiv', 'Osmanabad']],
  nashik: [['Nashik'], ['Malegaon'], ['Sinnar']],
  kolhapur: [['Kolhapur'], ['Ichalkaranji'], ['Gadhinglaj']],
};
const GEO_KM = 40;
const _cityKeys = new Map();
async function _city(names) {
  for (const n of names) {
    if (_cityKeys.has(n)) { if (_cityKeys.get(n)) return _cityKeys.get(n); continue; }   // a name Meta did not know: try the next one
    const r = await graph('search', { type: 'adgeolocation', location_types: ['city'], q: n, country_code: 'IN', limit: 10 }).catch(() => null);
    // the exact name first (e.g. Shirur, Pune — not Shirur Kasar, Beed), else a name that starts with it
    const mh = (r?.data || []).filter(x => /maharashtra/i.test(x.region || ''));
    const hit = mh.find(x => x.name.toLowerCase() === n.toLowerCase()) || mh.find(x => x.name.toLowerCase().startsWith(n.toLowerCase().split(' ')[0])) || null;
    _cityKeys.set(n, hit ? { key: String(hit.key), name: hit.name } : null);
    if (hit) return _cityKeys.get(n);
  }
  return null;
}
// the ad set's places: the whole state, or a group's towns (+ 40 km)
async function _geoOf(geo) {
  if (!geo || geo === 'all' || !GEO[geo]) {
    const region = await _maharashtra();
    return { geo: region ? { regions: [region], location_types: ['home', 'recent'] } : { countries: ['IN'] }, missed: [] };
  }
  const found = [], missed = [];
  for (const names of GEO[geo]) { const c = await _city(names); if (c) found.push(c); else missed.push(names[0]); }
  if (!found.length) throw Object.assign(new Error('Meta मध्ये या गटातली एकही शहरं सापडली नाहीत — "संपूर्ण महाराष्ट्र" निवडा'), { status: 400 });
  return { geo: { cities: [...new Map(found.map(c => [c.key, { key: c.key, radius: GEO_KM, distance_unit: 'kilometer' }])).values()], location_types: ['home', 'recent'] }, missed };
}
const GONE = ['DELETED', 'ARCHIVED'];
async function _findByName(edge, name, fields = 'id,name,status') {
  const r = await graph(`${env().account}/${edge}`, { fields, filtering: [{ field: 'name', operator: 'EQUAL', value: name }], limit: 5 });
  // a deleted / archived one (e.g. removed in Ads Manager) is never reused — a fresh one is made
  return (r.data || []).find(x => x.name === name && !GONE.includes(x.status)) || null;
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
// the WhatsApp bot's number (+91…) — a WhatsApp ad must open the bot, not another number linked to the Page
const _botNumber = () => { const n = String(process.env.WA_BOT_NUMBER || '').replace(/\D/g, ''); return /^91\d{10}$/.test(n) ? '+' + n : ''; };
// { name, audience, adset, daily_budget (₹), video_id, image_hash, message, headline, cta, link }
async function createAd(o) {
  const e = env();
  if (!e.page) throw Object.assign(new Error('Render मध्ये META_PAGE_ID नाही'), { status: 400 });
  const A = AUDIENCE[o.audience];
  if (!A) throw Object.assign(new Error('Unknown audience'), { status: 400 });
  // With a Meta dataset (results sent by our server) ad sets run for the result itself —
  // a free test given (Lead) / a teacher registered — not for clicks. Never for student ads.
  const ds = process.env.META_DATASET_ID || '';
  // 💬 a click-to-WhatsApp ad (o.dest === 'wa'): the button opens a chat with the bot's number (linked to the Page);
  // Meta runs it for conversations, and the bot may write free for 72 h to whoever wrote
  const toWa = o.dest === 'wa';
  let conv = !toWa && !!ds && o.audience !== 'student', note = '';
  let campaignName = toWa ? `${A.campaign} · WhatsApp` : conv ? `${A.campaign} · Leads` : A.campaign;
  let adsetName = toWa ? `${o.adset}-wa` : conv ? `${o.adset}-lead` : o.adset;
  const existing = (await graphAll(`${e.account}/ads`, { fields: 'id,name,status,adset{name}', filtering: [{ field: 'name', operator: 'EQUAL', value: o.name }], limit: '25' }))
    .find(x => x.name === o.name && !GONE.includes(x.status) && (!x.adset?.name || x.adset.name === adsetName));
  if (existing) return { exists: true, ad_id: existing.id, status: existing.status };

  const makeCampaign = async () => (await _findByName('campaigns', campaignName)) || post(`${e.account}/campaigns`, {
    name: campaignName, objective: toWa ? 'OUTCOME_ENGAGEMENT' : conv ? 'OUTCOME_LEADS' : 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false,
  });
  let campaign, adset;
  try {
    campaign = await makeCampaign();
    adset = await _findByName('adsets', adsetName) || await makeAdset();
  } catch (err) {
    if (!conv) throw err;
    // Meta would not make a "Free test" (Lead) ad set — run this one for clicks and say why
    note = `Meta ने "Free test" वर ad set बनवू दिला नाही (${err.message}) — हा ad set click वर बनवला`;
    conv = false; campaignName = A.campaign; adsetName = o.adset;
    campaign = await makeCampaign();
    adset = await _findByName('adsets', adsetName) || await makeAdset();
  }
  async function makeAdset() {
    const place = await _geoOf(o.geo);
    if (place.missed.length) note = (note ? note + ' · ' : '') + `Meta मध्ये ही शहरं सापडली नाहीत (बाकीची घेतली): ${place.missed.join(', ')}`;
    return post(`${e.account}/adsets`, {
      name: adsetName, campaign_id: campaign.id, status: 'PAUSED',
      daily_budget: Math.max(100, Math.round(Number(o.daily_budget) || 0)) * 100,   // paise
      billing_event: 'IMPRESSIONS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', destination_type: toWa ? 'WHATSAPP' : 'WEBSITE',
      ...(toWa ? { optimization_goal: 'CONVERSATIONS', promoted_object: { page_id: e.page, ...(_botNumber() ? { whatsapp_phone_number: _botNumber() } : {}) } } : conv
        ? { optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: ds, custom_event_type: o.audience === 'parent' ? 'LEAD' : 'COMPLETE_REGISTRATION' } }
        : { optimization_goal: 'LINK_CLICKS' }),
      targeting: {
        geo_locations: place.geo,
        // the admin's ages (Admin › Ads), else the audience's
        age_min: o.age_min || A.age_min, age_max: o.age_max || A.age_max,
        targeting_automation: { advantage_audience: 0 },
      },
    });
  }
  const ready = await _videoReady(o.video_id);
  if (!ready) return { pending: true, campaign_id: campaign.id, adset_id: adset.id, note };
  const creative = await _creative(o);
  const ad = await post(`${e.account}/ads`, { name: o.name, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED' });
  return { created: true, mode: toWa ? 'whatsapp' : conv ? 'lead' : 'clicks', note, ad_id: ad.id, adset_id: adset.id, campaign_id: campaign.id, creative_id: creative.id,
    manager: `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${e.account.replace(/^act_/, '')}&selected_ad_ids=${ad.id}` };
}

// the video post (page + optional Instagram identity, text, headline, button + link)
function _creative(o) {
  const e = env();
  return post(`${e.account}/adcreatives`, {
    name: o.name,
    object_story_spec: {
      page_id: e.page,
      ...(process.env.META_IG_ACTOR_ID ? { instagram_user_id: process.env.META_IG_ACTOR_ID } : {}),
      video_data: {
        video_id: o.video_id, image_hash: o.image_hash, message: o.message, title: o.headline,
        call_to_action: o.dest === 'wa'
          ? { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } }
          : { type: o.cta === 'SIGN_UP' ? 'SIGN_UP' : 'LEARN_MORE', value: { link: o.link } },
      },
    },
  });
}
// 🎬 a new video for an ad that is already in Meta (e.g. the first one froze): a new creative on the
// same ad — the ad keeps its name, ad set, budget and numbers; Meta reviews it again.
async function replaceVideo(o) {
  if (!/^\d+$/.test(String(o.ad_id))) throw Object.assign(new Error('Bad ad id'), { status: 400 });
  if (!env().page) throw Object.assign(new Error('Render मध्ये META_PAGE_ID नाही'), { status: 400 });
  const ad = await graph(String(o.ad_id), { fields: 'id,name,account_id' });
  if (`act_${ad.account_id}` !== env().account) throw Object.assign(new Error('Not this ad account'), { status: 400 });
  if (!(await _videoReady(o.video_id, 90000))) throw Object.assign(new Error('Meta अजून नवीन video तयार करत आहे — 2 मिनिटांनी पुन्हा "Video बदला" दाबा (video पुन्हा बनणार नाही)'), { status: 400, code: 'pending' });
  const creative = await _creative({ ...o, name: ad.name, dest: /-wa$/.test(ad.name) ? 'wa' : o.dest });
  await post(String(o.ad_id), { creative: { creative_id: creative.id } });
  _cache = null;
  return { name: ad.name, ad_id: ad.id, creative_id: creative.id };
}

// ── phase 3: Conversions API — our server tells Meta "this ad click led to a result" ──
// Only the click id Meta put in the link (fbc) and the browser's user agent go with it: no name,
// phone, marks or class. Never for ads aimed at students. Fire-and-forget: a failure is logged,
// never shown to the visitor.
const STUDENT_VARIANTS = ['challenge', 'rank', 'beat', 'r-shw', 'r-srev'];
const PARENT_ENDINGS = ['-demo-rank'];   // parent ads whose name also ends like a student ad
// a 🎬 script video for students: <class>-vs-<id>
const isStudentAd = adId => /(^|-)vs-[a-z0-9]+$/.test(String(adId || '')) || (!PARENT_ENDINGS.some(e => String(adId || '').endsWith(e)) && STUDENT_VARIANTS.some(v => String(adId || '').endsWith('-' + v)));
function datasetReady() { return !!process.env.META_DATASET_ID && configured().ok; }
async function sendEvent({ name, id, fbc, ua, url, value }) {
  if (!datasetReady() || !fbc) return { skipped: true };
  const ev = {
    event_name: name, event_time: Math.floor(Date.now() / 1000), event_id: id,
    action_source: 'website', event_source_url: url || `${process.env.PUBLIC_SITE_URL || 'https://teachingboard-frontend.vercel.app'}/student-app/`,   // PUBLIC_SITE_URL=https://nkseduorbit.in once live
    user_data: { fbc, ...(ua ? { client_user_agent: ua } : {}) },
    ...(value ? { custom_data: { value: Number(value), currency: 'INR' } } : {}),
  };
  return post(`${process.env.META_DATASET_ID}/events`, {
    data: [ev], ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {}),
  });
}
// fbclid from the ad link → fbc
const fbcOf = fbclid => { const c = String(fbclid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 300); return c ? `fb.1.${Date.now()}.${c}` : ''; };

// ── phase 4: the admin's buttons — pause / resume an ad, +20% on an ad set's daily budget ──
// every ad now in the account: status + its ad set's budget, keyed by the ad's name (our ad id)
async function adsState() {
  // the full picture; if Meta ever refuses one of the extra fields, the basic one (the panel still works)
  const rows = await graphAll(`${env().account}/ads`, { fields: 'id,name,effective_status,configured_status,created_time,ad_review_feedback,issues_info,adset{id,name,daily_budget,status,effective_status,created_time},campaign{id,name,status},creative{effective_object_story_id,instagram_permalink_url}', limit: '500' })
    .catch(err => { console.warn('[meta] ads (full fields):', err.message); return graphAll(`${env().account}/ads`, { fields: 'id,name,effective_status,configured_status,adset{id,name,daily_budget}', limit: '500' }); });
  const out = {};
  // why Meta stopped / refused an ad, in its own words (review feedback + delivery issues)
  const why = r => [...Object.values(r.ad_review_feedback?.global || {}), ...(r.issues_info || []).map(i => i.error_summary || i.error_message || '')].map(String).filter(Boolean).slice(0, 3);
  for (const r of rows) {
    const k = String(r.name || '').trim().toLowerCase();
    if (!k) continue;
    // the same ad name in two ad sets (clicks / results, or two areas): both are kept — the running one
    // under the plain name (the leaderboard uses it), the other one under "name · ad set"
    let key = k;
    if (out[k]) {
      const mineOn = (r.configured_status || r.effective_status) === 'ACTIVE', theirsOn = out[k].status === 'ACTIVE';
      if (mineOn && !theirsOn) out[`${k} · ${out[k].adset}`] = out[k];
      else key = `${k} · ${r.adset?.name || r.id}`;
    }
    out[key] = { name: r.name, ad_id: r.id, status: r.configured_status || r.effective_status || '', effective: r.effective_status || '',
      adset_id: r.adset?.id || '', adset: r.adset?.name || '', budget: r.adset?.daily_budget ? Number(r.adset.daily_budget) / 100 : null,
      adset_status: r.adset?.effective_status || r.adset?.status || '', adset_created: r.adset?.created_time || '',
      campaign_id: r.campaign?.id || '', campaign: r.campaign?.name || '', campaign_status: r.campaign?.status || '',
      created: r.created_time || '', why: why(r),
      // the public post people see (to share, and to read / answer comments)
      fb_post: r.creative?.effective_object_story_id ? `https://www.facebook.com/${r.creative.effective_object_story_id}` : '',
      ig_post: r.creative?.instagram_permalink_url || '' };
  }
  return out;
}
const MAX_STEP = 1.2;   // a budget never grows more than 20% in one go
async function setAdStatus(adId, status) {
  if (!/^\d+$/.test(String(adId))) throw Object.assign(new Error('Bad ad id'), { status: 400 });
  if (!['PAUSED', 'ACTIVE'].includes(status)) throw Object.assign(new Error('Bad status'), { status: 400 });
  const ad = await graph(String(adId), { fields: 'id,name,adset_id,campaign_id,account_id' });
  if (`act_${ad.account_id}` !== env().account) throw Object.assign(new Error('Not this ad account'), { status: 400 });
  let note = '';
  if (status === 'PAUSED') {
    // the last running ad of its ad set (e.g. the only NMMS ad): stop the ad set too, so the
    // spending really stops — the admin pressed ⏸ to stop paying
    const sibs = await graphAll(`${ad.adset_id}/ads`, { fields: 'id,configured_status', limit: '100' });
    const running = sibs.filter(s => s.configured_status === 'ACTIVE' && s.id !== ad.id);
    if (!running.length && ad.adset_id) { await post(String(ad.adset_id), { status: 'PAUSED' }); note = 'adset'; }
  }
  await post(String(adId), { status });
  // turning an ad on also turns on its ad set and campaign (made PAUSED by "Meta वर पाठवा"),
  // otherwise the ad would never run; pausing touches only the ad
  if (status === 'ACTIVE') {
    for (const id of [ad.adset_id, ad.campaign_id].filter(Boolean)) {
      const o = await graph(String(id), { fields: 'status' }).catch(() => null);
      if (o && o.status === 'PAUSED') await post(String(id), { status: 'ACTIVE' });
    }
  }
  _cache = null;
  return { ad_id: ad.id, name: ad.name, status, note };
}
async function raiseBudget(adsetId, pct = 20) {
  if (!/^\d+$/.test(String(adsetId))) throw Object.assign(new Error('Bad ad set id'), { status: 400 });
  const s = await graph(String(adsetId), { fields: 'id,name,daily_budget,account_id,updated_time' });
  if (`act_${s.account_id}` !== env().account) throw Object.assign(new Error('Not this ad account'), { status: 400 });
  const quietH = (Date.now() - new Date(s.updated_time || 0).getTime()) / 3600e3;
  if (s.updated_time && quietH < 72) throw Object.assign(new Error(`हा ad set ${Math.floor(quietH)} तासांपूर्वी बदलला / चालू केला — Meta शिकत आहे. अजून ${Math.ceil(72 - quietH)} तासांनी +20% करा.`), { status: 400 });
  const old = Number(s.daily_budget) || 0;
  if (!old) throw Object.assign(new Error('या ad set ला रोजचं बजेट नाही (campaign budget?) — Ads Manager मध्ये बदला'), { status: 400 });
  const step = Math.min(MAX_STEP, 1 + Math.max(1, Math.min(20, Number(pct) || 20)) / 100);
  const next = Math.round(old * step / 100) * 100;   // whole rupees, in paise
  await post(String(adsetId), { daily_budget: next });
  _cache = null;
  return { adset_id: s.id, name: s.name, from: old / 100, to: next / 100 };
}

// the admin's own figure for an ad set's daily budget (₹). Down: any amount ≥ ₹100. Up: at most +20% in one
// go unless `big` (a bigger jump restarts Meta's learning — the admin is asked first).
async function setBudget(adsetId, rupees, { big = false } = {}) {
  if (!/^\d+$/.test(String(adsetId))) throw Object.assign(new Error('Bad ad set id'), { status: 400 });
  const want = Math.round(Number(rupees));
  if (!Number.isFinite(want) || want < 100) throw Object.assign(new Error('रोजचं बजेट किमान ₹100'), { status: 400 });
  if (want > 100000) throw Object.assign(new Error('एवढं मोठं बजेट Ads Manager मध्येच ठेवा'), { status: 400 });
  const s = await graph(String(adsetId), { fields: 'id,name,daily_budget,account_id' });
  if (`act_${s.account_id}` !== env().account) throw Object.assign(new Error('Not this ad account'), { status: 400 });
  const old = (Number(s.daily_budget) || 0) / 100;
  if (!old) throw Object.assign(new Error('या ad set ला रोजचं बजेट नाही (campaign budget?) — Ads Manager मध्ये बदला'), { status: 400 });
  if (want > old * MAX_STEP + 0.5 && !big) throw Object.assign(new Error(`₹${old} → ₹${want} ही ${Math.round((want / old - 1) * 100)}% वाढ आहे — एकदम जास्त वाढवलं तर Meta पुन्हा शिकायला लागतो. तरी करायचं असेल तर पुन्हा दाबा.`), { status: 400, code: 'big' });
  await post(String(adsetId), { daily_budget: want * 100 });
  _cache = null;
  return { adset_id: s.id, name: s.name, from: old, to: want };
}

// 📍 the group's towns again on an ad set that already runs (e.g. a town was added to the group):
// only the places change — ages and the rest of its targeting stay
async function retarget(adsetId, geo) {
  if (!/^\d+$/.test(String(adsetId))) throw Object.assign(new Error('Bad ad set id'), { status: 400 });
  if (!GEO[geo]) throw Object.assign(new Error('Unknown area'), { status: 400 });
  const s = await graph(String(adsetId), { fields: 'id,name,account_id,targeting' });
  if (`act_${s.account_id}` !== env().account) throw Object.assign(new Error('Not this ad account'), { status: 400 });
  const place = await _geoOf(geo);
  await post(String(adsetId), { targeting: { ...(s.targeting || {}), geo_locations: place.geo } });
  _cache = null;
  return { name: s.name, towns: place.geo.cities.length, missed: place.missed };
}

module.exports = { configured, account, insights, retarget, graph, uploadVideo, uploadImage, createAd, adsState, setAdStatus, raiseBudget, setBudget, replaceVideo, sendEvent, fbcOf, isStudentAd, datasetReady, _resetCache: () => { _cache = null; _region = null; } };
