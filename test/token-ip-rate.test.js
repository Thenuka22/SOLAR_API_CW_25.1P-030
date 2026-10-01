const { test } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

test('the token endpoint limits requests from one client address', async () => {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/solar/v1.0/issue-token`;
    const send = () => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Validation rejects this before a database or expensive hash is used.
      body: '{}',
    });
    for (let n = 0; n < 30; n += 1) {
      const res = await send();
      assert.equal(res.status, 400, `request ${n + 1}`);
      await res.arrayBuffer();
    }
    const limited = await send();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.ok(limited.headers.get('ratelimit'));
    const body = await limited.json();
    assert.equal(body.code, 1009);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
