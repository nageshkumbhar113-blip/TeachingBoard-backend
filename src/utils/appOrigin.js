// Is this request from the installed app? The app's WebView sends its own origin
// (Capacitor: https://localhost, capacitor://localhost); the website sends its domain.
// Used by the महा-Test rules (website: the family's first महा-Test only) and to note
// that a student uses the app (User.app_first_at / app_last_day, Admin › महा-Test list).
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost',
  ...String(process.env.APP_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)]);

const isAppRequest = req => APP_ORIGINS.has(String(req?.headers?.origin || ''));

module.exports = { isAppRequest, APP_ORIGINS };
