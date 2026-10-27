import { createHash } from 'node:crypto';

const fields = ['channelId','kind','status','address','sourceId','siteId','identityScope',
  'sourceRecordId','sourceUrl','observedAt','instructionExcerpt','location','binding',
  'verificationMethod','deliveryVerified','submitted'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 300) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const fail = () => Error('Invalid manual email application candidate');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceUrl(value) {
  try { const u = new URL(value); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
/** Address normalization only. No DNS, SMTP, account lookup or message sending. */
export function manualEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 260 || /[\u0000-\u0020\u007f,;<>]/.test(value)) return null;
  const raw = value.startsWith('mailto:') ? value.slice(7) : value;
  // Query/fragment parameters and multiple recipients never reach a clipboard.
  if (/[?#%]/.test(raw)) return null;
  const match = /^([A-Za-z0-9.!$&'*+/=^_`{|}~-]{1,64})@([^@]{1,190})$/.exec(raw);
  if (!match || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..')) return null;
  if (['\\','/',':','[',']'].some(c => match[2].includes(c))) return null;
  let domain; try { domain = new URL('https://' + match[2]).hostname; } catch { return null; }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(domain) ||
      new URL('https://' + match[2]).host !== domain) return null;
  return match[1] + '@' + domain.toLowerCase();
}
function identity(record) {
  return [record.sourceId,record.siteId,record.identityScope,String(record.sourceRecordId ?? '')];
}
function channelKey(channel) {
  return [channel.sourceId,channel.siteId,channel.identityScope,channel.sourceRecordId,
    channel.sourceUrl,channel.binding.kind,channel.binding.nativeJobId,channel.address];
}
export function assertManualEmailChannel(channel) {
  if (!plain(channel) || Object.keys(channel).some(key => !fields.includes(key)) ||
      channel.kind !== 'manual_email' || channel.status !== 'candidate' ||
      channel.verificationMethod !== 'official_instruction_observed' ||
      channel.deliveryVerified !== false || channel.submitted !== false ||
      manualEmailAddress(channel.address) !== channel.address ||
      !['sourceId','siteId','identityScope','sourceRecordId'].every(key => text(channel[key],2048)) ||
      !text(channel.sourceUrl,4096) || !sourceUrl(channel.sourceUrl) ||
      !text(channel.instructionExcerpt) ||
      !text(channel.observedAt,40) || !Number.isFinite(Date.parse(channel.observedAt)) ||
      !plain(channel.location) || Object.keys(channel.location).join(',') !== 'selector' ||
      !text(channel.location.selector,300) || !plain(channel.binding) ||
      Object.keys(channel.binding).sort().join(',') !== 'kind,nativeJobId' ||
      channel.binding.kind !== 'native_row' || channel.binding.nativeJobId !== channel.sourceRecordId ||
      channel.channelId !== 'email-' + digest(channelKey(channel)).slice(0,24)) throw fail();
  return channel;
}
export function assertApplicationChannels(channels) {
  if (!Array.isArray(channels) || channels.length > 4) throw fail();
  const ids = new Set();
  for (const channel of channels) {
    assertManualEmailChannel(channel);
    if (ids.has(channel.channelId)) throw fail();
    ids.add(channel.channelId);
  }
  return channels;
}
export function officialEmailCandidate({record,address,sourceUrl: url,observedAt,instructionExcerpt,selector}) {
  const normalized = manualEmailAddress(address);
  if (!normalized || record.sourceId !== 'official-announcements' || record.kind !== 'job' || record.sourceRecordIdKind !== 'authority') return null;
  const [sourceId,siteId,identityScope,sourceRecordId] = identity(record);
  const channel = { kind:'manual_email', status:'candidate', address:normalized,
    sourceId,siteId,identityScope,sourceRecordId,sourceUrl:url,observedAt,
    instructionExcerpt,location:{selector},binding:{kind:'native_row',nativeJobId:sourceRecordId},
    verificationMethod:'official_instruction_observed',deliveryVerified:false,submitted:false };
  channel.channelId = 'email-' + digest(channelKey(channel)).slice(0,24);
  return assertManualEmailChannel(channel);
}
/** New complete observations may revoke only their own source-row candidates.
 * Other already-related source proofs remain distinct; nothing becomes verified. */
export function mergeApplicationChannels(older,newer) {
  const left = older.applicationChannels || [], right = newer.applicationChannels || [];
  assertApplicationChannels(left); assertApplicationChannels(right);
  const incomingIdentity = identity(newer).join('\u0000');
  const revoke = Object.hasOwn(newer,'applicationChannels') && newer.bodyStatus === 'complete';
  const retained = left.filter(channel => !revoke || identity(channel).join('\u0000') !== incomingIdentity);
  const entries = new Map(retained.map(channel => [channel.channelId,channel]));
  for (const channel of right) entries.set(channel.channelId,channel);
  const all = [...entries.values()].sort((a,b) => String(b.observedAt).localeCompare(String(a.observedAt)) || a.channelId.localeCompare(b.channelId));
  return {channels:structuredClone(all.slice(0,4)),overflow:all.length > 4 || older.applicationChannelOverflow === true};
}