import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

test('生产模式强制 HTTPS 且禁止 Demo 身份绕过', () => {
  assert.throws(() => loadConfig({
    nodeEnv: 'production',
    demoMode: false,
    issuer: 'http://example.com',
  }), /HTTPS/);
  assert.throws(() => loadConfig({
    nodeEnv: 'production',
    demoMode: true,
    issuer: 'https://sso.example.com',
  }), /禁止启用/);
});

test('接入页明示固定版本的真实兼容边界', async () => {
  const [script, view, readme] = await Promise.all([
    readFile(new URL('../public/connect.js', import.meta.url), 'utf8'),
    readFile(new URL('../views/connect.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  assert.match(view, /provider-note/);
  assert.match(script, /New API rc\.25/);
  assert.match(script, /localhost:3000/);
  assert.match(script, /One API v0\.6\.10/);
  assert.match(script, /Wire\/API 兼容/);
  assert.match(readme, /f116414/);
  assert.match(readme, /3915ce9/);
  assert.match(readme, /不宣称完整 UI 端到端兼容/);
});
