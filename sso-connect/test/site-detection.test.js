import assert from 'node:assert/strict';
import test from 'node:test';

import { isBlockedAddress, normalizeSiteUrl } from '../src/site-detection.js';

test('真实商家只接受干净的 HTTPS Origin', () => {
  assert.equal(normalizeSiteUrl('example.com/path?q=1'), 'https://example.com');
  assert.throws(() => normalizeSiteUrl('http://example.com'), /HTTPS/);
  assert.throws(() => normalizeSiteUrl('https://user:pass@example.com'), /账号、密码/);
  assert.throws(() => normalizeSiteUrl('ftp://example.com'), /HTTP 或 HTTPS/);
});

test('loopback HTTP 只在 Demo 模式允许且私网地址被识别', () => {
  assert.equal(
    normalizeSiteUrl('http://127.0.0.1:8021/path', { demoMode: true }),
    'http://127.0.0.1:8021',
  );
  assert.throws(() => normalizeSiteUrl('http://127.0.0.1:8021'), /HTTPS/);
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
});
