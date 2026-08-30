import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { importJWK, SignJWT } from 'jose';

import { startServers } from '../src/server.js';
import { registerClient } from '../src/provider.js';

let directory;
let runtime;

test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'zeroone-e2e-'));
  runtime = await startServers({
    dataDir: directory,
    issuer: 'http://127.0.0.1:8140',
    internalOrigin: 'http://127.0.0.1:8140',
    platformPort: 8140,
    merchantPort: 8141,
    demoMerchantOrigin: 'http://127.0.0.1:8141',
    demoMode: true,
  });
});

test.afterAll(async () => {
  await runtime?.stop();
  await rm(directory, { recursive: true, force: true });
});

test('一键接入、PKCE 登录和账号复用', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('http://127.0.0.1:8140/connect?demo=1');
  await expect(page.getByRole('heading', { name: '连接你的站点' })).toBeVisible();
  await page.getByRole('button', { name: '自动接入' }).click();
  await page.waitForURL('http://127.0.0.1:8141/?sso=success');
  await expect(page.getByRole('heading', { name: '已进入 零一演示商家' })).toBeVisible();
  await expect(page.getByText('商家用户数').locator('..')).toContainText('1');

  await page.getByRole('link', { name: '返回接入结果' }).click();
  await expect(page.getByRole('heading', { name: '已接入，可一键登录' })).toBeVisible();
  const integrationId = await page.evaluate(() => sessionStorage.getItem('zeroone.integrationId'));
  const persisted = await page.evaluate(async (id) => (
    fetch(`/api/integrations/${id}`).then((response) => response.json())
  ), integrationId);
  expect(persisted.clientSecret).toBeUndefined();
  const rotated = await page.evaluate(async (id) => {
    const csrf = document.querySelector('meta[name="csrf-token"]').content;
    return fetch(`/api/integrations/${id}/rotate-secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{}',
    }).then((response) => response.json());
  }, integrationId);
  expect(rotated.clientSecret).toBeTruthy();
  expect(runtime.database.prepare(
    'SELECT COUNT(*) AS count FROM merchant_integrations WHERE normalized_origin = ?',
  ).get('http://127.0.0.1:8141').count).toBe(1);
  await page.getByRole('link', { name: '进入商家' }).click();
  await page.waitForURL('http://127.0.0.1:8141/?sso=success');
  await expect(page.getByText('商家用户数').locator('..')).toContainText('1');
  expect(errors).toEqual([]);
});

test('邀请点击与成功注册分开计数且去重', async ({ browser }) => {
  const owner = await browser.newContext();
  const ownerPage = await owner.newPage();
  await ownerPage.goto('http://127.0.0.1:8140/invites');
  const inviteLink = await ownerPage.getByRole('textbox', { name: '你的邀请链接' }).inputValue();

  const invitee = await browser.newContext();
  const inviteePage = await invitee.newPage();
  await inviteePage.goto(inviteLink);
  await inviteePage.getByLabel('演示邮箱').fill('playwright-invitee@example.com');
  await inviteePage.getByRole('button', { name: '注册并模拟验证' }).click();
  await inviteePage.getByRole('button', { name: '一键继续' }).click();
  await inviteePage.waitForURL('**/invites?verified=1');

  await ownerPage.reload();
  await expect(ownerPage.locator('#invite-clicks')).toHaveText('1');
  await expect(ownerPage.locator('#invite-registrations')).toHaveText('1');

  await inviteePage.goto(inviteLink);
  await inviteePage.getByLabel('演示邮箱').fill('playwright-invitee@example.com');
  await inviteePage.getByRole('button', { name: '注册并模拟验证' }).click();
  await inviteePage.getByRole('button', { name: '一键继续' }).click();
  await ownerPage.reload();
  await expect(ownerPage.locator('#invite-clicks')).toHaveText('1');
  await expect(ownerPage.locator('#invite-registrations')).toHaveText('1');

  await owner.close();
  await invitee.close();
});

test('390px 窄屏无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8140/connect?demo=1');
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasOverflow).toBe(false);
});

async function legacyAuthorizationCode(page, client) {
  await page.goto('http://127.0.0.1:8140/connect?demo=1');
  const authorization = new URL('http://127.0.0.1:8140/oauth/authorize');
  authorization.searchParams.set('client_id', client.clientId);
  authorization.searchParams.set('redirect_uri', 'http://127.0.0.1:8140/test/callback');
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('scope', 'openid profile email');
  authorization.searchParams.set('state', 'legacy-state');
  await page.goto(authorization.href);
  await page.waitForURL('**/test/callback?**');
  const callback = new URL(page.url());
  return { code: callback.searchParams.get('code'), error: callback.searchParams.get('error') };
}

test('New API 兼容客户端使用表单换 Token 且授权码不可重放', async ({ page }) => {
  const client = await registerClient(runtime.provider, {
    name: 'New API 兼容测试',
    redirectUri: 'http://127.0.0.1:8140/test/callback',
    template: 'new-api',
    trusted: true,
  });
  const { code, error } = await legacyAuthorizationCode(page, client);
  expect(error).toBeNull();
  expect(code).toBeTruthy();
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: 'http://127.0.0.1:8140/test/callback',
  });
  const wrongSecret = new URLSearchParams(body);
  wrongSecret.set('client_secret', 'wrong-secret');
  const rejected = await fetch('http://127.0.0.1:8140/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: wrongSecret,
  });
  expect(rejected.status).toBe(401);
  const first = await fetch('http://127.0.0.1:8140/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  expect(first.status).toBe(200);
  expect((await first.json()).access_token).toBeTruthy();

  const replay = await fetch('http://127.0.0.1:8140/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  expect(replay.status).toBe(400);
  expect((await replay.json()).error).toBe('invalid_grant');
});

test('One API JSON 兼容入口规范化后完成换 Token', async ({ page }) => {
  const client = await registerClient(runtime.provider, {
    name: 'One API 兼容测试',
    redirectUri: 'http://127.0.0.1:8140/test/callback',
    template: 'one-api',
    trusted: true,
  });
  const { code } = await legacyAuthorizationCode(page, client);
  const response = await fetch('http://127.0.0.1:8140/compat/one-api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: 'http://127.0.0.1:8140/test/callback',
    }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).access_token).toBeTruthy();
});

test('标准自研客户端缺少 PKCE 时被拒绝', async ({ page }) => {
  const client = await registerClient(runtime.provider, {
    name: '标准 PKCE 测试',
    redirectUri: 'http://127.0.0.1:8140/test/callback',
    template: 'custom',
    trusted: true,
  });
  const result = await legacyAuthorizationCode(page, client);
  expect(result.code).toBeNull();
  expect(result.error).toBe('invalid_request');
});

test('signed handoff 可登录且拒绝重复 jti', async ({ browser }) => {
  const handoffDir = await mkdtemp(path.join(os.tmpdir(), 'zeroone-handoff-'));
  const handoffRuntime = await startServers({
    dataDir: handoffDir,
    issuer: 'http://127.0.0.1:8150',
    internalOrigin: 'http://127.0.0.1:8150',
    platformPort: 8150,
    merchantPort: 8151,
    demoMerchantOrigin: 'http://127.0.0.1:8151',
    demoMode: true,
  });
  try {
    handoffRuntime.demoMerchant.configure({
      issuer: handoffRuntime.config.issuer,
      clientId: 'handoff-demo',
      clientSecret: 'not-used-by-handoff',
      redirectUri: 'http://127.0.0.1:8151/oauth/oidc',
    });
    const integrationId = randomUUID();
    const owner = handoffRuntime.repository.ensureDemoUser();
    handoffRuntime.repository.saveIntegration({
      id: integrationId,
      ownerUserId: owner.id,
      siteUrl: handoffRuntime.config.demoMerchantOrigin,
      origin: handoffRuntime.config.demoMerchantOrigin,
      kind: 'handoff',
      clientId: 'handoff-demo',
      redirectUri: 'http://127.0.0.1:8151/oauth/oidc',
      handoffUrl: 'http://127.0.0.1:8151/zeroone/sso/handoff',
      status: 'ready',
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:8150/connect?demo=1');
    await page.goto(`http://127.0.0.1:8150/sso/merchants/${integrationId}/start`);
    await page.waitForURL('http://127.0.0.1:8151/?sso=handoff');
    await expect(page.getByRole('heading', { name: '已进入 零一演示商家' })).toBeVisible();

    const privateJwk = handoffRuntime.secrets.jwks.keys[0];
    const key = await importJWK(privateJwk, 'RS256');
    const jti = randomUUID();
    const token = await new SignJWT({
      sub: 'replay-test-sub',
      email: 'replay@example.com',
      email_verified: true,
      name: '重放测试',
    })
      .setProtectedHeader({ alg: 'RS256', kid: privateJwk.kid })
      .setIssuer(handoffRuntime.config.issuer)
      .setAudience(handoffRuntime.config.demoMerchantOrigin)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key);
    const invalid = await fetch('http://127.0.0.1:8151/zeroone/sso/handoff', {
      method: 'POST', headers: { authorization: 'Bearer invalid.jwt.value' }, body: '{}',
    });
    expect(invalid.status).toBe(400);
    const first = await fetch('http://127.0.0.1:8151/zeroone/sso/handoff', {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
    });
    expect(first.status).toBe(200);
    const replay = await fetch('http://127.0.0.1:8151/zeroone/sso/handoff', {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
    });
    expect(replay.status).toBe(409);
    await context.close();
  } finally {
    await handoffRuntime.stop();
    await rm(handoffDir, { recursive: true, force: true });
  }
});

test('仅实现 handoff 的商家不需要提供 /api/status', async ({ page }) => {
  const handoffOnly = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => handoffOnly.listen(8160, '127.0.0.1', resolve));
  try {
    await page.goto('http://127.0.0.1:8140/connect?demo=1');
    const result = await page.evaluate(async () => {
      const csrf = document.querySelector('meta[name="csrf-token"]').content;
      const response = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ siteUrl: 'http://127.0.0.1:8160', type: 'handoff' }),
      });
      return { status: response.status, body: await response.json() };
    });
    expect(result.status).toBe(201);
    expect(result.body.type).toBe('handoff');
  } finally {
    await new Promise((resolve) => handoffOnly.close(resolve));
  }
});

test('非受信商家首次获取资料前必须由用户明确确认', async ({ page }) => {
  const integrationId = randomUUID();
  const owner = runtime.repository.ensureDemoUser();
  const client = await registerClient(runtime.provider, {
    name: '外部授权测试商家',
    redirectUri: 'http://127.0.0.1:8140/test/callback',
    template: 'new-api',
    integrationId,
    trusted: false,
  });
  runtime.repository.saveIntegration({
    id: integrationId,
    ownerUserId: owner.id,
    siteUrl: 'http://127.0.0.1:8161',
    origin: 'http://127.0.0.1:8161',
    kind: 'new-api',
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: 'http://127.0.0.1:8140/test/callback',
    startUrl: 'http://127.0.0.1:8161/login',
    status: 'ready_for_test',
  });
  await page.goto('http://127.0.0.1:8140/connect?demo=1');
  const authorization = new URL('http://127.0.0.1:8140/oauth/authorize');
  authorization.searchParams.set('client_id', client.clientId);
  authorization.searchParams.set('redirect_uri', 'http://127.0.0.1:8140/test/callback');
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('scope', 'openid profile email');
  authorization.searchParams.set('state', 'explicit-consent');
  await page.goto(authorization.href);
  await expect(page.getByRole('heading', { name: '登录到 外部授权测试商家' })).toBeVisible();
  await page.getByRole('button', { name: '一键继续' }).click();
  await page.waitForURL('**/test/callback?**');
  expect(new URL(page.url()).searchParams.get('code')).toBeTruthy();
});
