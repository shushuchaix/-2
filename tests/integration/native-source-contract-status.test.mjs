import test from 'node:test';
import assert from 'node:assert/strict';
import {safeSourceIssues} from '../../src/sources/source-status.mjs';
test('native public contract failures keep a precise safe diagnostic code',()=>{const [issue]=safeSourceIssues([{code:'native_transport_contract_mismatch',message:'private marker',details:{text:'private marker'}}],'official-announcements','synthetic-site');assert.equal(issue.code,'native_transport_contract_mismatch');assert.equal(JSON.stringify(issue).includes('private marker'),false);});
