import { createHash, timingSafeEqual } from 'node:crypto';

function provider(model) {
  try {
    const url = new URL(model.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { baseUrl: url.href, model: String(model.model || '') };
  } catch { return null; }
}
function digest(apiKey, configured) {
  return createHash('sha256').update(JSON.stringify([apiKey, configured.baseUrl, configured.model])).digest('hex');
}

// This record contains no credential. Its name is intentionally removed by the
// existing business/API/backup secret redactor as one complete settings row.
export function createModelCredentialBinding(apiKey, model) {
  const configured = provider(model);
  if (typeof apiKey !== 'string' || !configured) throw Error('Invalid model credential binding input');
  return { version: 1, configured: Boolean(apiKey), ...configured,
    ...(apiKey ? { fingerprint: digest(apiKey, configured) } : {}) };
}

export function matchesModelCredentialBinding(apiKey, model, binding) {
  const configured = provider(model);
  if (!apiKey || typeof apiKey !== 'string' || !configured || binding?.version !== 1 ||
      binding.configured !== true || binding.baseUrl !== configured.baseUrl || binding.model !== configured.model ||
      !/^[0-9a-f]{64}$/.test(binding.fingerprint || '')) return false;
  return timingSafeEqual(Buffer.from(binding.fingerprint, 'hex'), Buffer.from(digest(apiKey, configured), 'hex'));
}
