// WhatsApp Cloud API: the webhook signature check and sending one message.
// WhatsApp limits: reply buttons ≤ 3 with titles ≤ 20 characters; a list ≤ 10 rows with titles ≤ 24;
// an interactive body ≤ 1024 characters; a text ≤ 4096. Longer things are split / shortened here,
// so the rules (waFlow.js) never have to know about them.

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
// constant-time compare of two hex strings
export function sameHex(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// X-Hub-Signature-256: sha256=<hex of HMAC(app secret, raw body)>
export async function validSignature(env, raw, header) {
  if (!env.META_APP_SECRET) return false;
  const got = String(header || '').replace(/^sha256=/, '');
  return sameHex(got, await hmacHex(env.META_APP_SECRET, raw));
}

const chars = s => [...String(s || '')].length;
const cut = (s, n) => { const a = [...String(s || '')]; return a.length <= n ? a.join('') : a.slice(0, n - 1).join('') + '…'; };

// the request bodies for one engine message ({ text, buttons }) — 1 or 2 messages
export function bodiesFor(to, text, buttons) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  const out = [];
  buttons = (buttons || []).filter(b => b && b.id && b.label).slice(0, 10);
  if (!buttons.length) {
    // a very long text goes in 4096-character parts
    const parts = []; let rest = [...String(text || '')];
    while (rest.length) { parts.push(rest.slice(0, 4096).join('')); rest = rest.slice(4096); }
    for (const p of parts) out.push({ ...base, type: 'text', text: { body: p, preview_url: true } });
    return out;
  }
  let body = String(text || '');
  if (chars(body) > 1024) { out.push(...bodiesFor(to, body, [])); body = '👇'; }
  const asButtons = buttons.length <= 3 && buttons.every(b => chars(b.label) <= 20);
  out.push({
    ...base, type: 'interactive',
    interactive: asButtons
      ? { type: 'button', body: { text: body }, action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: cut(b.id, 256), title: b.label } })) } }
      : { type: 'list', body: { text: body }, action: { button: 'पर्याय निवडा', sections: [{ title: 'पर्याय', rows: buttons.map(b => ({ id: cut(b.id, 200), title: cut(b.label, 24) })) }] } },
  });
  return out;
}

// a pre-approved template (the only kind Meta allows outside the 24 h window); {{1}} = the child's name
export function templateBody(to, name, lang, param) {
  return {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name, language: { code: lang || 'mr' }, components: param ? [{ type: 'body', parameters: [{ type: 'text', text: cut(param, 60) }] }] : [] },
  };
}

// POST one body; returns the WhatsApp message id or throws
export async function post(env, body) {
  const url = `${env.GRAPH_URL}/${env.GRAPH_VERSION}/${env.WA_PHONE_ID}/messages`;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${j?.error?.message || 'error'}`);
  return j?.messages?.[0]?.id || '';
}

// what the parent sent, as the text / button id the rules understand
export function inboundText(m) {
  if (m.type === 'text') return m.text?.body || '';
  if (m.type === 'interactive') return m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '';
  if (m.type === 'button') return m.button?.payload || m.button?.text || '';
  return '';
}
