import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadOrCreateSecrets } from '../src/secrets.js';

test('并发首次启动原子发布同一套持久化密钥', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zeroone-secrets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'data', 'secrets.json');
  const results = await Promise.all(
    Array.from({ length: 4 }, () => loadOrCreateSecrets(filename)),
  );
  assert.equal(new Set(results.map((item) => item.databaseKey)).size, 1);
  assert.equal(new Set(results.map((item) => item.jwks.keys[0].kid)).size, 1);
  assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
});

test('损坏的 secrets.json 会失败关闭而不是静默换钥匙', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zeroone-secrets-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'secrets.json');
  await writeFile(filename, '{"databaseKey":"broken"}\n');
  await assert.rejects(() => loadOrCreateSecrets(filename));
});
