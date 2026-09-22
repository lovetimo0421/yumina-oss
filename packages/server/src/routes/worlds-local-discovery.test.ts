import assert from 'node:assert/strict';
import test from 'node:test';
import { worldRoutes } from './worlds.js';
import { edition } from '../edition/index.js';
import { localEdition } from '../edition/local.js';

test('local edition refuses hosted discovery even when the cursor rollout flag is set', async (t) => {
  t.mock.method(edition, 'info', localEdition.info);
  const flag = process.env.DISCOVERY_CURSOR_ENABLED;
  const rollout = process.env.DISCOVERY_CURSOR_ROLLOUT_PERCENT;
  process.env.DISCOVERY_CURSOR_ENABLED = 'true';
  process.env.DISCOVERY_CURSOR_ROLLOUT_PERCENT = '100';
  try {
    const interests = await worldRoutes.request('/hub/interests?lang=en');
    assert.equal(interests.status, 404, 'local edition must not query hosted starter interests');
    for (const query of ['feed=recommended&pagination=cursor', 'feed=recommended', 'q=story']) {
      const response = await worldRoutes.request(`/hub?${query}`);
      assert.equal(response.status, 404, 'local hub is disabled before ranking or querying hosted tables');
      assert.equal(response.headers.get('set-cookie'), null);
    }
  } finally {
    if (flag === undefined) delete process.env.DISCOVERY_CURSOR_ENABLED;
    else process.env.DISCOVERY_CURSOR_ENABLED = flag;
    if (rollout === undefined) delete process.env.DISCOVERY_CURSOR_ROLLOUT_PERCENT;
    else process.env.DISCOVERY_CURSOR_ROLLOUT_PERCENT = rollout;
  }
});
