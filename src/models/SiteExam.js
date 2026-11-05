const { mongoose } = require('../config/db');

// Admin › 🗺️ Site / Exams: one exam's public page (nkseduorbit.in/exams/<slug>).
// The admin edits the fields; "Publish" copies the checked ones into `live`, and only
// `live` is ever shown on the website (so a half-done edit never goes out).
const dateSchema = new mongoose.Schema({
  label: { type: String, trim: true, maxlength: 60, default: '' },   // "परीक्षा", "Form शेवटची तारीख"
  date:  { type: Date, default: null },                               // null = अजून जाहीर नाही
  note:  { type: String, trim: true, maxlength: 80, default: '' },
}, { _id: false });

const faqSchema = new mongoose.Schema({
  q: { type: String, trim: true, maxlength: 200, default: '' },
  a: { type: String, trim: true, maxlength: 1200, default: '' },
}, { _id: false });

const siteExamSchema = new mongoose.Schema(
  {
    slug:        { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 40 },
    order:       { type: Number, default: 100 },
    group:       { type: String, enum: ['school', 'senior'], default: 'school' },   // landing-page tab
    name:        { type: String, required: true, trim: true, maxlength: 80 },        // "NMMS (8वी)"
    name_en:     { type: String, trim: true, maxlength: 80, default: '' },
    class_label: { type: String, trim: true, maxlength: 40, default: '' },           // "8वी"
    purpose:     { type: String, trim: true, maxlength: 400, default: '' },          // one paragraph
    benefit:     { type: String, trim: true, maxlength: 80, default: '' },           // short: "₹48,000 शिष्यवृत्ती"
    eligibility: { type: String, trim: true, maxlength: 1500, default: '' },
    pattern:     { type: String, trim: true, maxlength: 2000, default: '' },         // one line per row: "MAT | 90 प्रश्न | 90 गुण"
    syllabus:    { type: String, trim: true, maxlength: 2000, default: '' },
    official_url:{ type: String, trim: true, maxlength: 300, default: '' },
    dates:       { type: [dateSchema], default: [] },
    faq:         { type: [faqSchema], default: [] },
    batch:       { type: String, trim: true, maxlength: 120, default: '' },          // the app class it sells ('' = लवकरच)
    animation:   { type: String, enum: ['auto', 'days', 'question', 'none'], default: 'auto' },   // auto: days left when a date is set, else a real question,
    // what the ads say about it (optional — empty = the ads' own default line)
    ad_loss_mr:  { type: String, trim: true, maxlength: 80, default: '' },           // "…आणि ₹48,000 ची शिष्यवृत्ती गेली"
    ad_loss_en:  { type: String, trim: true, maxlength: 80, default: '' },
    enabled:     { type: Boolean, default: true },
    verified_on: { type: Date, default: null },     // the admin checked the facts against the official site
    live:        { type: mongoose.Schema.Types.Mixed, default: null },   // the published copy
    published_at:{ type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false, minimize: false }
);

module.exports = mongoose.models.SiteExam || mongoose.model('SiteExam', siteExamSchema);
