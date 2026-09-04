const { isSafeImageUrl, isSafeAudioUrl } = require('./security');

// Shared between order.js (new orders) and order-edit.js (editing an existing
// one) so the two paths can never validate a payload differently.
const MAX_COLLAGE_PHOTOS = 15;

function validateOrderPayload(payload) {
  const required = [
    ['orderId', payload.orderId],
    ['templateId', payload.templateId],
    ['category', payload.category],
    ['config.coupleNames', payload.config && payload.config.coupleNames],
    ['config.date', payload.config && payload.config.date],
    ['config.venueName', payload.config && payload.config.venueName],
    ['customer.name', payload.customer && payload.customer.name],
    ['customer.contact', payload.customer && payload.customer.contact],
  ];
  const missing = required.filter(([, value]) => !value).map(([field]) => field);

  const config = payload.config || {};
  const invalid = [];
  if (config.heroPhotoUrl && !isSafeImageUrl(config.heroPhotoUrl)) {
    invalid.push('config.heroPhotoUrl');
  }
  if (config.collagePhotos !== undefined) {
    if (!Array.isArray(config.collagePhotos) || config.collagePhotos.length > MAX_COLLAGE_PHOTOS) {
      invalid.push('config.collagePhotos');
    } else if (!config.collagePhotos.every(isSafeImageUrl)) {
      invalid.push('config.collagePhotos');
    }
  }
  if (config.musicUrl && !isSafeAudioUrl(config.musicUrl)) {
    invalid.push('config.musicUrl');
  }

  return { missing, invalid };
}

module.exports = { validateOrderPayload, MAX_COLLAGE_PHOTOS };
