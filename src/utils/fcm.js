/**
 * FCM push notification sender — gracefully optional.
 *
 * To enable:
 *   1. npm install firebase-admin  (in TeachingBoard-backend)
 *   2. Set FIREBASE_SERVICE_ACCOUNT env var to the JSON string of your
 *      Firebase service account key (from Firebase Console → Project Settings
 *      → Service accounts → Generate new private key).
 *
 * If firebase-admin is not installed or FIREBASE_SERVICE_ACCOUNT is not set,
 * all send calls are no-ops — the rest of the app works normally.
 */

let _messaging = null;

function _init() {
  if (_messaging) return _messaging;

  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) return null;

  try {
    // Parse JSON
    let serviceAccount;
    try {
      serviceAccount = typeof sa === 'string' ? JSON.parse(sa) : sa;
    } catch (parseErr) {
      console.warn('FCM: JSON parse failed —', parseErr.message);
      return null;
    }

    // Render env vars sometimes double-escape \n → actual newlines required for PEM
    if (serviceAccount.private_key && typeof serviceAccount.private_key === 'string') {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    const { initializeApp, getApps, cert } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');

    if (!getApps().length) {
      initializeApp({ credential: cert(serviceAccount) });
    }

    _messaging = getMessaging();
    console.log('FCM: Initialized successfully');
    return _messaging;
  } catch (err) {
    console.warn('FCM: Init failed —', err.message);
    console.warn('FCM: Stack —', err.stack);
    return null;
  }
}

/**
 * Send a push notification to a single FCM device token.
 * Silently no-ops if FCM is not configured.
 */
async function sendToUser(deviceToken, title, body, data = {}) {
  const messaging = _init();
  if (!messaging || !deviceToken) return;

  const message = {
    token: deviceToken,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    android: {
      priority: 'high',
      notification: { sound: 'default', clickAction: 'FLUTTER_NOTIFICATION_CLICK' },
    },
    apns: {
      payload: { aps: { sound: 'default' } },
    },
  };

  await messaging.send(message);
}

/**
 * Send to multiple device tokens (batch, max 500 per FCM call).
 */
async function sendToMany(deviceTokens, title, body, data = {}) {
  const messaging = _init();
  if (!messaging || !deviceTokens?.length) return;

  const tokens = deviceTokens.filter(Boolean);
  if (!tokens.length) return;

  const message = {
    tokens,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    android: { priority: 'high', notification: { sound: 'default' } },
    apns: { payload: { aps: { sound: 'default' } } },
  };

  await messaging.sendEachForMulticast(message);
}

module.exports = { sendToUser, sendToMany };
