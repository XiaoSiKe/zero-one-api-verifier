import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import request from 'supertest';

import {
  pairwiseSubject,
  registerClient,
  rotateClientSecret,
} from '../src/provider.js';
import { createRuntime } from '../src/server.js';

test('Discovery、JWKS 与 Client 加密持久化可用', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zeroone-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = await createRuntime({
    dataDir: dir,
    issuer: 'http://127.0.0.1:8120',
    demoMerchantOrigin: 'http://127.0.0.1:8121',
    platformPort: 8120,
    merchantPort: 8121,
    demoMode: true,
  });
  t.after(() => runtime.close());

  const discovery = await request(runtime.platformApp)
    .get('/.well-known/openid-configuration')
    .set('host', '127.0.0.1:8120')
    .expect(200);
  assert.equal(discovery.body.issuer, 'http://127.0.0.1:8120');
  assert.equal(discovery.body.authorization_endpoint, 'http://127.0.0.1:8120/oauth/authorize');
  assert.equal(discovery.body.token_endpoint, 'http://127.0.0.1:8120/oauth/token');
  assert.deepEqual(discovery.body.token_endpoint_auth_methods_supported, ['client_secret_post']);
  assert.equal(discovery.body.pushed_authorization_request_endpoint, undefined);
  assert.equal(discovery.body.dpop_signing_alg_values_supported, undefined);

  const jwks = await request(runtime.platformApp)
    .get('/.well-known/jwks.json')
    .set('host', '127.0.0.1:8120')
    .expect(200);
  assert.equal(jwks.body.keys[0].alg, 'RS256');
  assert.ok(jwks.body.keys[0].kid);
  assert.equal(jwks.body.keys[0].d, undefined);

  const client = await registerClient(runtime.provider, {
    name: '测试商家',
    redirectUri: 'https://merchant.example.com/oauth/oidc',
    template: 'new-api',
  });
  const stored = runtime.database.prepare(
    "SELECT payload_ciphertext FROM oidc_artifacts WHERE model = 'Client' AND id = ?",
  ).get(client.clientId);
  assert.ok(stored.payload_ciphertext.startsWith('v1.'));
  assert.equal(stored.payload_ciphertext.includes(client.clientSecret), false);

  const resolved = await runtime.provider.Client.find(client.clientId);
  assert.equal(resolved.zeroone_legacy_no_pkce, true);
  assert.equal(resolved.redirectUris[0], 'https://merchant.example.com/oauth/oidc');
  assert.equal(resolved.compareClientSecret(client.clientSecret), true);
  const rotated = await rotateClientSecret(runtime.provider, client.clientId);
  const refreshed = await runtime.provider.Client.find(client.clientId);
  assert.equal(refreshed.compareClientSecret(rotated.clientSecret), true);
  assert.equal(refreshed.compareClientSecret(client.clientSecret), false);
});

test('pairwise sub 对同一商家稳定、不同商家不可关联', () => {
  const salt = Buffer.alloc(32, 7).toString('base64url');
  const first = pairwiseSubject(salt, 'user-1', { clientId: 'merchant-a', sectorIdentifier: 'a.example' });
  const repeated = pairwiseSubject(salt, 'user-1', { clientId: 'merchant-a', sectorIdentifier: 'a.example' });
  const other = pairwiseSubject(salt, 'user-1', { clientId: 'merchant-b', sectorIdentifier: 'b.example' });
  assert.equal(first, repeated);
  assert.notEqual(first, other);
});

test('One API 兼容 Discovery 只替换 Token 入口', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zeroone-one-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = await createRuntime({
    dataDir: dir,
    issuer: 'http://127.0.0.1:8130',
    demoMerchantOrigin: 'http://127.0.0.1:8131',
    platformPort: 8130,
    merchantPort: 8131,
    demoMode: true,
  });
  t.after(() => runtime.close());
  const response = await request(runtime.platformApp)
    .get('/compat/one-api/.well-known/openid-configuration')
    .expect(200);
  assert.equal(response.body.issuer, 'http://127.0.0.1:8130');
  assert.equal(response.body.token_endpoint, 'http://127.0.0.1:8130/compat/one-api/token');
  assert.equal(response.body.userinfo_endpoint, 'http://127.0.0.1:8130/oauth/userinfo');
});
