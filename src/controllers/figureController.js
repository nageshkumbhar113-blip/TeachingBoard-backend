const { v2: cloudinary } = require('cloudinary');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

const MAX_PER_CALL = 10;
const MAX_CHARS = 400 * 1024;   // one figure PNG is ~5–30 KB; anything near this is not a figure

// POST /api/questions/figures/upload { images: ["data:image/png;base64,…", …] } -> { urls: [...] }
// Figures drawn by Admin › Create Quiz › Reasoning प्रश्न and question pictures cut from a PDF in
// Admin › Import. Only these small PNG/JPEG pieces are stored; the PDF itself never reaches the server.
exports.uploadFigures = asyncHandler(async (req, res) => {
  const images = Array.isArray(req.body?.images) ? req.body.images : null;
  if (!images || !images.length) throw new AppError('images must be a non-empty array', 400);
  if (images.length > MAX_PER_CALL) throw new AppError(`At most ${MAX_PER_CALL} images at a time`, 400);
  for (const d of images) {
    if (typeof d !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(d)) throw new AppError('Only PNG/JPEG/WebP images', 400);
    if (d.length > MAX_CHARS) throw new AppError('Image too large', 400);
  }
  if (!process.env.CLOUDINARY_CLOUD_NAME) throw new AppError('Cloudinary not configured', 500);
  const urls = [];
  for (const d of images) {
    const r = await cloudinary.uploader.upload(d, {
      folder: 'teachingboard/figures',
      resource_type: 'image',
      allowed_formats: ['png', 'jpg', 'jpeg', 'webp'],
    });
    urls.push(r.secure_url);
  }
  res.json({ success: true, urls });
});
