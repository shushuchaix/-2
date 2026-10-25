import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTION_LIMIT_CAPS, collectionLimitsFor, validateCollectionLimits } from '../../public/js/validation-rules.js';

test('total response bytes support bounded 512 MiB without changing activity defaults', () => {
  assert.equal(COLLECTION_LIMIT_CAPS.maxTotalAttachmentBytes, 536870912);
  for (const mode of ['standard', 'broad']) {
    assert.equal(collectionLimitsFor(mode).maxTotalAttachmentBytes, 200 * 1048576);
    const existing = { maxTotalAttachmentBytes: 300 * 1048576, maxRequests: 3171, maxDetails: 187, maxAttachments: 10, maxCostCny: 6.13 };
    const before = structuredClone(existing);
    const result = collectionLimitsFor(mode, existing);
    for (const [key,value] of Object.entries(existing)) assert.equal(result[key],value);
    assert.deepEqual(existing,before);
  }
});

test('explicit 300 and 512 MiB limits are retained exactly, larger or malformed values fail', () => {
  for (const bytes of [300 * 1048576, 527344993, 512 * 1048576])
    assert.equal(validateCollectionLimits({maxTotalAttachmentBytes:bytes}).maxTotalAttachmentBytes,bytes);
  for (const bytes of [536870913,-1,1.5,NaN,Infinity,'536870912'])
    assert.throws(()=>validateCollectionLimits({maxTotalAttachmentBytes:bytes}));
});

test('byte support does not enlarge any other resource or money cap', () => {
  assert.deepEqual(COLLECTION_LIMIT_CAPS, {
    maxSites:50,maxRequests:10000,maxPagesPerQuery:20,maxDetails:600,maxQueryGroups:12,
    maxAttachments:40,maxAttachmentBytes:20*1048576,maxTotalAttachmentBytes:512*1048576,
    maxPageRequests:60,maxPageBytes:20*1048576,maxCostCny:10,
  });
});
