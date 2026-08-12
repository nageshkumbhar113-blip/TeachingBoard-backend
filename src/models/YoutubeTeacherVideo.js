const { mongoose } = require('../config/db');

/**
 * YoutubeTeacherVideo — one teacher's video (or one "part" of a video) for a
 * specific Batch+Subject+Chapter+Exercise. Keyed by the same string-identity
 * pattern as the rest of the codebase (batch/subject/chapter names +
 * exerciseNo — see exerciseViewer.js / exerciseManager.js), not ObjectIds.
 *
 * live_* fields are what students currently see; pending_* is an edit
 * awaiting re-approval (App-store-update pattern — the old approved video
 * keeps showing until the new one is approved, per plan Section 7 "My Videos").
 */
const youtubeTeacherVideoSchema = new mongoose.Schema(
  {
    youtube_teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'YoutubeTeacherPartner', required: true, index: true },

    batch_name:   { type: String, required: true, trim: true },
    subject_name: { type: String, required: true, trim: true },
    chapter_name: { type: String, required: true, trim: true },
    exercise_no:  { type: String, required: true, trim: true },

    // normalized (lowercase/hyphenated) — used for the duplicate-check index
    // so "Part 1" and "part 1" don't create two separate videos by accident.
    part_key:   { type: String, default: '', trim: true, lowercase: true },
    part_label: { type: String, default: '', trim: true }, // display label, e.g. "Part 1" — empty = single video

    // LIVE — what students see right now
    live_video_id:   { type: String, default: '' },
    live_part_label: { type: String, default: '' },

    // PENDING — an edit awaiting admin approval; promoted to live_* on approve
    pending_video_id:     { type: String, default: '' },
    pending_part_label:   { type: String, default: '' },
    pending_submitted_at: { type: Date, default: null },

    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    rejection_reason: { type: String, default: '' },
    last_rejection_reason: { type: String, default: '' },
    last_rejected_at:      { type: Date, default: null },

    open_count: { type: Number, default: 0 }, // "Video Opens" metric (not official YouTube views)

    approved_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

// Same teacher + same exercise + same part = one record (duplicate guard).
// Different parts (part_key) on the same exercise are allowed — multi-part videos.
youtubeTeacherVideoSchema.index(
  { youtube_teacher_id: 1, batch_name: 1, subject_name: 1, chapter_name: 1, exercise_no: 1, part_key: 1 },
  { unique: true }
);

// Student-facing lookup: "all approved videos for this exercise".
youtubeTeacherVideoSchema.index({ batch_name: 1, subject_name: 1, chapter_name: 1, exercise_no: 1, status: 1 });

module.exports = mongoose.models.YoutubeTeacherVideo ||
  mongoose.model('YoutubeTeacherVideo', youtubeTeacherVideoSchema);
