const crypto = require('crypto');

// Razorpay credentials come from env. Test-mode and live-mode keys are separate.
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
function getKeyId()        { return process.env.RAZORPAY_KEY_ID || ''; }
function getKeySecret()    { return process.env.RAZORPAY_KEY_SECRET || ''; }
function getWebhookSecret(){ return process.env.RAZORPAY_WEBHOOK_SECRET || ''; }

function isConfigured() {
  return !!(getKeyId() && getKeySecret());
}

/**
 * Create a Razorpay order via the REST API (no SDK dependency).
 * @param {{ amount:number, currency?:string, receipt?:string, notes?:object }} opts
 *        amount is in PAISE (integer).
 * @returns {Promise<object>} the Razorpay order object
 */
async function createOrder({ amount, currency = 'INR', receipt = '', notes = {} }) {
  if (!isConfigured()) throw new Error('Razorpay is not configured on the server');

  const amountPaise = Math.round(Number(amount));
  if (!Number.isFinite(amountPaise) || amountPaise < 100) {
    throw new Error('Invalid amount (must be at least ₹1)');
  }

  const auth = Buffer.from(`${getKeyId()}:${getKeySecret()}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: amountPaise, currency, receipt, notes, payment_capture: 1 }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.description || `Razorpay order failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

/**
 * Verify a Razorpay webhook signature (X-Razorpay-Signature header).
 * Must be computed over the RAW request body bytes.
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = getWebhookSecret();
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return _safeEqualHex(expected, signature);
}

/**
 * Verify the payment signature returned to the frontend by Razorpay Checkout
 * (razorpay_order_id|razorpay_payment_id signed with the key secret).
 */
function verifyPaymentSignature(orderId, paymentId, signature) {
  const secret = getKeySecret();
  if (!secret || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return _safeEqualHex(expected, signature);
}

function _safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'hex');
  const bufB = Buffer.from(String(b), 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  isConfigured,
  getKeyId,
  createOrder,
  verifyWebhookSignature,
  verifyPaymentSignature,
};
