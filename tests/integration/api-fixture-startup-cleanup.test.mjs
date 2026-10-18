import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { apiFixture } from '../helpers/api-fixture.mjs';
import { createTempDir } from '../helpers/fixtures.mjs';

test('api fixture closes its HTTP server when application readiness rejects', async t => {
  const dataDir = await createTempDir(t), cleanup = [];
  const fixtureContext = { after(callback) { cleanup.push(callback); } };
  const listen = Server.prototype.listen;
  let server;
  Server.prototype.listen = function (...args) { server = this; return listen.apply(this, args); };
  try {
    await assert.rejects(apiFixture(fixtureContext, { dataDir, dependencies: {
      onStartupStage() { throw Error('synthetic startup failure'); },
    } }), /synthetic startup failure/);
    assert.equal(server.listening, true, 'the fixture opened an HTTP listener');
    assert.equal(cleanup.length, 1);
    await assert.doesNotReject(cleanup[0]());
    assert.equal(server.listening, false, 'rejected readiness still closes the listener');
  } finally {
    Server.prototype.listen = listen;
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
