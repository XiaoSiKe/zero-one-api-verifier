import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { importJWK, SignJWT } from 'jose';

import { registerClient } from '../src/provider.js';
import { startServers } from '../src/server.js';

const ISSUER = 'http://127.0.0.1:8170';
const MERCHANT = 'http://127.0.0.1:8171';

let directory;
let runtime;
let demoIntegrationId;

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'zeroone-security-e2e-'));
  runtime = await startServers({
    dataDir: directory,
    issuer: ISSUER,
    internalOrigin: ISSUER,
    platformPort: 8170,
    merchantPort: 8171,
    demoMerchantOrigin: MERCHANT,
    demoMode: true,
  });
  const owner = runtime.repository.ensureDemoUser();
  demoIntegrationId = randomUUID();
  const client = await registerClient(runtime.provider, {
    name: '安全测试演示商家',
    redirectUri: `${MERCHANT}/oauth/oidc`,
    template: 'demo',
    integrationId: demoIntegrationId,
    trusted: true,
  });
  runtime.repository.saveIntegration({
    id: demoIntegrationId,
    ownerUserId: owner.id,
    siteUrl: MERCHANT,
    origin: MERCHANT,
    kind: 'demo',
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: `${MERCHANT}/oauth/oidc`,
    startUrl: `${MERCHANT}/sso/zeroone/start`,
    status: 'ready',
  });
  runtime.demoMerchant.configure({
    issuer: ISSUER,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: `${MERCHANT}/oauth/oidc`,
  });
});

test.afterAll(async () => {
  await runtime?.stop();
  await rm(directory, { recursive: true, force: true });
});

test.beforeEach(() => {
  runtime.demoMerchant.database.prepare('DELETE FROM demo_flows').run();
});

async function merchantCallbackUrl(page) {
  let target = `${ISSUER}/sso/merchants/${demoIntegrationId}/start`;
  for (let step = 0; step < 10; step += 1) {
    const response = await page.context().request.get(target, { maxRedirects: 0 });
    const location = response.headers().location;
    expect(location, `redirect missing at ${target}`).toBeTruthy();
    const next = new URL(location, target);
    if (next.origin === MERCHANT && next.pathname === '/oauth/oidc') return next;
    target = next.href;
  }
  throw new Error('OAuth redirect limit exceeded');
}

test('演示商家拒绝被篡改的 OAuth state', async ({ page }) => {
  const callback = await merchantCallbackUrl(page);
  callback.searchParams.set('state', 'tampered-state');
  const response = await page.goto(callback.href);
  expect(response.status()).toBe(400);
  await expect(page.getByRole('heading', { name: '演示商家登录失败' })).toBeVisible();
});

test('演示商家拒绝 nonce 与本地流程不匹配的 ID Token', async ({ page }) => {
  const callback = await merchantCallbackUrl(page);
  const result = runtime.demoMerchant.database.prepare(
    "UPDATE demo_flows SET nonce = 'tampered-nonce'",
  ).run();
  expect(result.changes).toBe(1);
  const response = await page.goto(callback.href);
  expect(response.status()).toBe(400);
  await expect(page.getByRole('heading', { name: '演示商家登录失败' })).toBeVisible();
});

async function signedHandoffToken({
  issuer = ISSUER,
  audience = MERCHANT,
  expiresAt = Math.floor(Date.now() / 1000) + 60,
  jti = randomUUID(),
} = {}) {
  const privateJwk = runtime.secrets.jwks.keys[0];
  const key = await importJWK(privateJwk, 'RS256');
  let jwt = new SignJWT({
    sub: `handoff-${randomUUID()}`,
    email: `handoff-${randomUUID()}@example.com`,
    email_verified: true,
    name: '安全回归测试',
  })
    .setProtectedHeader({ alg: 'RS256', kid: privateJwk.kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt);
  if (typeof jti === 'string') jwt = jwt.setJti(jti);
  return jwt.sign(key);
}

function postHandoff(token) {
  return fetch(`${MERCHANT}/zeroone/sso/handoff`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
}

test('handoff 拒绝错误 issuer/audience、过期 Token 和缺失 jti', async () => {
  const now = Math.floor(Date.now() / 1000);
  const candidates = [
    { token: await signedHandoffToken({ issuer: 'https://wrong-issuer.example' }), status: 400 },
    { token: await signedHandoffToken({ audience: 'https://wrong-audience.example' }), status: 400 },
    { token: await signedHandoffToken({ expiresAt: now - 30 }), status: 400 },
    { token: await signedHandoffToken({ jti: null }), status: 401 },
  ];
  for (const { token, status } of candidates) {
    const response = await postHandoff(token);
    expect(response.status).toBe(status);
  }
});

test('handoff jti 和一次性登录票据均不可重放', async () => {
  const token = await signedHandoffToken();
  const first = await postHandoff(token);
  expect(first.status).toBe(200);
  const payload = await first.json();
  expect(payload.success).toBe(true);

  const replayedJti = await postHandoff(token);
  expect(replayedJti.status).toBe(409);

  const firstTicket = await fetch(payload.redirect_url, { redirect: 'manual' });
  expect(firstTicket.status).toBe(302);
  expect(firstTicket.headers.get('location')).toBe('/?sso=handoff');
  const replayedTicket = await fetch(payload.redirect_url, { redirect: 'manual' });
  expect(replayedTicket.status).toBe(400);
});

test('handoff 拒绝未就绪 Integration 与商家返回的开放跳转', async ({ page }) => {
  let requests = 0;
  const maliciousMerchant = createServer((_req, res) => {
    requests += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      success: true,
      external_user_id: 'malicious-user',
      redirect_url: 'https://evil.example/steal-session',
    }));
  });
  await new Promise((resolve) => maliciousMerchant.listen(0, '127.0.0.1', resolve));
  const { port } = maliciousMerchant.address();
  const origin = `http://127.0.0.1:${port}`;
  const unreadyOrigin = 'http://127.0.0.1:9';
  const owner = runtime.repository.ensureDemoUser();
  const unreadyId = randomUUID();
  const readyId = randomUUID();
  runtime.repository.saveIntegration({
    id: unreadyId,
    ownerUserId: owner.id,
    siteUrl: unreadyOrigin,
    origin: unreadyOrigin,
    kind: 'handoff',
    clientId: `handoff_${randomUUID()}`,
    redirectUri: `${unreadyOrigin}/oauth/oidc`,
    handoffUrl: `${unreadyOrigin}/zeroone/sso/handoff`,
    status: 'awaiting_configuration',
  });
  runtime.repository.saveIntegration({
    id: readyId,
    ownerUserId: owner.id,
    siteUrl: origin,
    origin,
    kind: 'handoff',
    clientId: `handoff_${randomUUID()}`,
    redirectUri: `${origin}/oauth/oidc`,
    handoffUrl: `${origin}/zeroone/sso/handoff`,
    status: 'ready',
  });
  try {
    const unready = await page.goto(`${ISSUER}/sso/merchants/${unreadyId}/start`);
    expect(unready.status()).toBe(409);
    await expect(page.getByText('请先完成配置检查，再发起一键登录。')).toBeVisible();
    expect(requests).toBe(0);

    const openRedirect = await page.goto(`${ISSUER}/sso/merchants/${readyId}/start`);
    expect(openRedirect.status()).toBe(400);
    await expect(page.getByText('商家返回了未登记域名的跳转地址')).toBeVisible();
    expect(requests).toBe(1);
  } finally {
    await new Promise((resolve) => maliciousMerchant.close(resolve));
  }
});
