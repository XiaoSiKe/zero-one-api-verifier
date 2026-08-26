import assert from 'node:assert/strict';
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
