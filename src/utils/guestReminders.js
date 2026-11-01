const GuestLead = require('../models/GuestLead');
const { sendToUser } = require('./fcm');

// Evening nudge for free-part visitors who installed the app but have not
// paid yet (docs/PLAN_guest_funnel.md): one push a day, at most 7 in all,
// only while they were active in the last 14 days. Paid / converted leads
// never get one. The message follows their state.
const MAX_REMINDERS = 7;
const ACTIVE_DAYS = 14;

const GENERAL = [
  ['📝 आजचा free test तयार आहे!', 'कालपेक्षा जास्त गुण मिळवा — फक्त 10 मिनिटं 💪'],
  ['🏆 तुमचा क्रमांक सुधारा!', 'आज एक test द्या आणि मित्रांना मागे टाका'],
  ['🔥 सलग सराव = जास्त गुण', 'आजचा free भाग पूर्ण करा'],
  ['📚 पुढचा chapter वाट पाहतोय', 'Notes वाचा, मग test द्या — app तुम्हाला step by step नेईल'],
];

function messageFor(lead, now = new Date()) {
  const name = lead.name ? `${lead.name}, ` : '';
  if (lead.offer?.expires_at && new Date(lead.offer.expires_at) > now) {
    return ['⏳ तुमची सवलत लवकरच संपेल', `${name}पहिल्या payment वर ${lead.offer.percent || 50}% सवलत — सगळे tests उघडा`];
  }
  if (!lead.tests) return ['🎯 पहिला free test द्या!', `${name}10 मिनिटांत तुमचा result आणि क्रमांक बघा`];
  const [title, body] = GENERAL[(lead.reminders_sent || 0) % GENERAL.length];
  return [title, name + body];
}

async function sendGuestReminders(todayIst, now = new Date()) {
  const since = new Date(now.getTime() - ACTIVE_DAYS * 864e5);
  const leads = await GuestLead.find({
    device_token: { $ne: '' },
    converted_code: '',
    reminders_sent: { $lt: MAX_REMINDERS },
    last_seen_at: { $gte: since },
    last_reminder_date: { $ne: todayIst },
  }).limit(2000).lean();
  let sent = 0;
  for (const lead of leads) {
    const [title, body] = messageFor(lead, now);
    try {
      await sendToUser(lead.device_token, title, body, { type: 'guest_reminder' });
      sent++;
    } catch { /* bad token — counted anyway so it stops after 7 */ }
    await GuestLead.updateOne({ _id: lead._id }, { $inc: { reminders_sent: 1 }, $set: { last_reminder_date: todayIst } });
  }
  return sent;
}

module.exports = { sendGuestReminders, messageFor, MAX_REMINDERS };
