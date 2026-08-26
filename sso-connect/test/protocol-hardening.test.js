import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import request from 'supertest';

import { registerClient } from '../src/provider.js';
import { createRuntime } from '../src/server.js';

const ISSUER = 'http://127.0.0.1:8174';
const CALLBACK = `${ISSUER}/test/callback`;
const HOST = '127.0.0.1:8174';

let directory;
let runtime;
let ipSequence = 1;

test.before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'zeroone-protocol-hardening-'));
  runtime = await createRuntime({
    dataDir: directory,
    issuer: ISSUER,
    demoMerchantOrigin: 'http://127.0.0.1:8175',
    platformPort: 8174,
    merchantPort: 8175,
    demoMode: true,
  });
  runtime.platformApp.set('trust proxy', true);
});

test.after(async () => {
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
});

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function csrfFor(sessionId) {
  return createHmac('sha256', Buffer.from(runtime.secrets.cookieKey, 'base64url'))
    .update(`csrf:${sessionId}`)
    .digest('base64url');
}

function nextTestIp() {
  const ip = `192.0.2.${ipSequence}`;
  ipSequence += 1;
  return ip;
}

async function loggedInAgent() {
  const agent = request.agent(runtime.platformApp);
  await agent.get('/connect?demo=1').set('host', HOST).expect(200);
  return agent;
}

async function issueAuthorizationCode({
  clientId,
  redirectUri = CALLBACK,
  state = randomUUID(),
  nonce,
  codeChallenge,
}) {
  const agent = await loggedInAgent();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    ...(nonce ? { nonce } : {}),
    ...(codeChallenge ? {
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    } : {}),
  });
  let target = `/oauth/authorize?${params}`;
  const forwardedFor = nextTestIp();

  for (let step = 0; step < 10; step += 1) {
    const response = await agent
      .get(target)
      .set('host', HOST)
      .set('x-forwarded-for', forwardedFor);
    assert.ok(response.headers.location, `authorization stopped with HTTP ${response.status}`);
    const location = new URL(response.headers.location, ISSUER);
    if (location.pathname === new URL(redirectUri).pathname
      && location.origin === new URL(redirectUri).origin) {
      return location;
    }
    assert.equal(location.origin, ISSUER, 'provider redirected outside the expected flow');
    target = `${location.pathname}${location.search}`;
  }
  throw new Error('authorization redirect limit exceeded');
}

function tokenRequest({ clientId, clientSecret, code, redirectUri = CALLBACK, verifier }) {
  return request(runtime.platformApp)
    .post('/oauth/token')
    .set('host', HOST)
    .set('x-forwarded-for', nextTestIp())
    .type('form')
    .send({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      ...(verifier ? { code_verifier: verifier } : {}),
    });
}

test('PKCE S256 签发 RS256 Token，校验 nonce/state 并保持 pairwise sub', async () => {
  const firstClient = await registerClient(runtime.provider, {
    name: 'PKCE 协议加固 A',
    redirectUri: CALLBACK,
    template: 'custom',
    trusted: true,
  });
  const firstPkce = pkcePair();
  const state = randomUUID();
  const nonce = randomUUID();
  const callback = await issueAuthorizationCode({
    clientId: firstClient.clientId,
    state,
    nonce,
    codeChallenge: firstPkce.challenge,
  });
  assert.equal(callback.searchParams.get('state'), state);
  const firstTokens = await tokenRequest({
    clientId: firstClient.clientId,
    clientSecret: firstClient.clientSecret,
    code: callback.searchParams.get('code'),
    verifier: firstPkce.verifier,
  }).expect(200);
  assert.equal(decodeProtectedHeader(firstTokens.body.id_token).alg, 'RS256');
  const {
    d: _d,
    p: _p,
    q: _q,
    dp: _dp,
    dq: _dq,
    qi: _qi,
    ...publicJwk
  } = runtime.secrets.jwks.keys[0];
  const key = await importJWK(publicJwk, 'RS256');
  const firstClaims = (await jwtVerify(firstTokens.body.id_token, key, {
    issuer: ISSUER,
    audience: firstClient.clientId,
  })).payload;
  assert.equal(firstClaims.nonce, nonce);

  const userInfo = await request(runtime.platformApp)
    .get('/oauth/userinfo')
    .set('host', HOST)
    .set('authorization', `Bearer ${firstTokens.body.access_token}`)
    .expect(200);
  assert.equal(userInfo.body.sub, firstClaims.sub);
  assert.equal(userInfo.body.email_verified, true);

  const repeatedPkce = pkcePair();
  const repeatedCallback = await issueAuthorizationCode({
    clientId: firstClient.clientId,
    nonce: randomUUID(),
    codeChallenge: repeatedPkce.challenge,
  });
  const repeatedTokens = await tokenRequest({
    clientId: firstClient.clientId,
    clientSecret: firstClient.clientSecret,
    code: repeatedCallback.searchParams.get('code'),
    verifier: repeatedPkce.verifier,
  }).expect(200);
  const repeatedClaims = (await jwtVerify(repeatedTokens.body.id_token, key, {
    issuer: ISSUER,
    audience: firstClient.clientId,
  })).payload;
  assert.equal(repeatedClaims.sub, firstClaims.sub);

  const secondClient = await registerClient(runtime.provider, {
    name: 'PKCE 协议加固 B',
    redirectUri: 'http://localhost:8174/test/callback',
    template: 'custom',
    trusted: true,
  });
  const secondPkce = pkcePair();
  const secondCallback = await issueAuthorizationCode({
    clientId: secondClient.clientId,
    redirectUri: 'http://localhost:8174/test/callback',
    nonce: randomUUID(),
    codeChallenge: secondPkce.challenge,
  });
  const secondTokens = await tokenRequest({
    clientId: secondClient.clientId,
    clientSecret: secondClient.clientSecret,
    code: secondCallback.searchParams.get('code'),
    redirectUri: 'http://localhost:8174/test/callback',
    verifier: secondPkce.verifier,
  }).expect(200);
  const secondClaims = (await jwtVerify(secondTokens.body.id_token, key, {
    issuer: ISSUER,
    audience: secondClient.clientId,
  })).payload;
  assert.notEqual(secondClaims.sub, firstClaims.sub);
});

test('拒绝未登记 Client、非精确 Redirect URI 与未就绪 Integration', async () => {
  const unknown = await request(runtime.platformApp)
    .get('/oauth/authorize')
    .set('host', HOST)
    .query({
      client_id: 'not-registered',
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: 'openid',
    });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.location, undefined);

  const registered = await registerClient(runtime.provider, {
    name: 'Redirect URI 加固',
    redirectUri: CALLBACK,
    template: 'custom',
    trusted: true,
  });
  const redirectMismatch = await request(runtime.platformApp)
    .get('/oauth/authorize')
    .set('host', HOST)
    .query({
      client_id: registered.clientId,
      redirect_uri: `${ISSUER}/other/callback`,
      response_type: 'code',
      scope: 'openid',
    });
  assert.equal(redirectMismatch.status, 400);
  assert.equal(redirectMismatch.headers.location, undefined);

  const unlinked = await registerClient(runtime.provider, {
    name: '未经平台登记',
    redirectUri: CALLBACK,
    template: 'custom',
    trusted: false,
  });
  const unlinkedPkce = pkcePair();
  const unlinkedAgent = await loggedInAgent();
  const unlinkedStart = await unlinkedAgent
    .get('/oauth/authorize')
    .set('host', HOST)
    .query({
      client_id: unlinked.clientId,
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: 'openid',
      code_challenge: unlinkedPkce.challenge,
      code_challenge_method: 'S256',
    })
    .expect(303);
  const unlinkedInteraction = await unlinkedAgent
    .get(unlinkedStart.headers.location)
    .set('host', HOST)
    .expect(400);
  assert.match(unlinkedInteraction.text, /尚未经过平台登记/);

  const integrationId = randomUUID();
  const owner = runtime.repository.ensureDemoUser();
  const unready = await registerClient(runtime.provider, {
    name: '未完成配置检查',
    redirectUri: CALLBACK,
    template: 'custom',
    integrationId,
    trusted: false,
  });
  runtime.repository.saveIntegration({
    id: integrationId,
    ownerUserId: owner.id,
    siteUrl: 'https://unready.example',
    origin: 'https://unready.example',
    kind: 'custom',
    clientId: unready.clientId,
    clientSecret: unready.clientSecret,
    redirectUri: CALLBACK,
    status: 'awaiting_configuration',
  });
  const unreadyPkce = pkcePair();
  const unreadyAgent = await loggedInAgent();
  const unreadyStart = await unreadyAgent
    .get('/oauth/authorize')
    .set('host', HOST)
    .query({
      client_id: unready.clientId,
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: 'openid',
      code_challenge: unreadyPkce.challenge,
      code_challenge_method: 'S256',
    })
    .expect(303);
  const unreadyInteraction = await unreadyAgent
    .get(unreadyStart.headers.location)
    .set('host', HOST)
    .expect(400);
  assert.match(unreadyInteraction.text, /尚未通过配置检查/);
});

test('拒绝错误 PKCE、Client Secret、Token Redirect URI 和过期授权码', async () => {
  const standard = await registerClient(runtime.provider, {
    name: 'PKCE 错误矩阵',
    redirectUri: CALLBACK,
    template: 'custom',
    trusted: true,
  });
  const pkce = pkcePair();
  const callback = await issueAuthorizationCode({
    clientId: standard.clientId,
    codeChallenge: pkce.challenge,
  });
  const wrongVerifier = await tokenRequest({
    clientId: standard.clientId,
    clientSecret: standard.clientSecret,
    code: callback.searchParams.get('code'),
    verifier: randomBytes(32).toString('base64url'),
  });
  assert.equal(wrongVerifier.status, 400);
  assert.equal(wrongVerifier.body.error, 'invalid_grant');

  const legacy = await registerClient(runtime.provider, {
    name: 'Secret 与 Redirect 矩阵',
    redirectUri: CALLBACK,
    template: 'new-api',
    trusted: true,
  });
  const wrongSecretCode = await issueAuthorizationCode({ clientId: legacy.clientId });
  const wrongSecret = await tokenRequest({
    clientId: legacy.clientId,
    clientSecret: 'wrong-secret',
    code: wrongSecretCode.searchParams.get('code'),
  });
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.body.error, 'invalid_client');

  const wrongRedirectCode = await issueAuthorizationCode({ clientId: legacy.clientId });
  const wrongRedirect = await tokenRequest({
    clientId: legacy.clientId,
    clientSecret: legacy.clientSecret,
    code: wrongRedirectCode.searchParams.get('code'),
    redirectUri: `${ISSUER}/other/callback`,
  });
  assert.equal(wrongRedirect.status, 400);
  assert.equal(wrongRedirect.body.error, 'invalid_grant');

  const expiredCode = await issueAuthorizationCode({ clientId: legacy.clientId });
  const code = expiredCode.searchParams.get('code');
  runtime.database.prepare(`
    UPDATE oidc_artifacts SET expires_at = ?
    WHERE model = 'AuthorizationCode' AND id = ?
  `).run(Math.floor(Date.now() / 1000) - 1, code);
  const expired = await tokenRequest({
    clientId: legacy.clientId,
    clientSecret: legacy.clientSecret,
    code,
  });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error, 'invalid_grant');
});

test('10 路并发兑换同一授权码只能成功一次', async () => {
  const client = await registerClient(runtime.provider, {
    name: '并发授权码防重放',
    redirectUri: CALLBACK,
    template: 'new-api',
    trusted: true,
  });
  const callback = await issueAuthorizationCode({ clientId: client.clientId });
  const requests = Array.from({ length: 10 }, () => tokenRequest({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    code: callback.searchParams.get('code'),
  }));
  const responses = await Promise.all(requests);
  assert.equal(responses.filter(({ status }) => status === 200).length, 1);
  assert.equal(responses.filter(({ status }) => status === 400).length, 9);
  for (const response of responses.filter(({ status }) => status === 400)) {
    assert.equal(response.body.error, 'invalid_grant');
  }
});

test('Integration 配置按所有者隔离且所有变更必须通过 CSRF', async () => {
  const owner = runtime.repository.ensureDemoUser();
  const integrationId = randomUUID();
  const client = await registerClient(runtime.provider, {
    name: '所有者隔离测试',
    redirectUri: CALLBACK,
    template: 'new-api',
    integrationId,
    trusted: true,
  });
  runtime.repository.saveIntegration({
    id: integrationId,
    ownerUserId: owner.id,
    siteUrl: 'https://owner-isolation.example',
    origin: 'https://owner-isolation.example',
    kind: 'new-api',
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: CALLBACK,
    status: 'ready',
  });

  const now = Math.floor(Date.now() / 1000);
  const otherUserId = randomUUID();
  runtime.database.prepare(`
    INSERT INTO users (
      id, email, display_name, email_verified, invite_code, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(otherUserId, `${otherUserId}@example.com`, '其他商家', randomUUID(), now, now);
  const otherSession = runtime.repository.createSession(otherUserId);
  const otherCookie = `zeroone_sso_session=${otherSession}`;
  const otherCsrf = csrfFor(otherSession);

  await request(runtime.platformApp)
    .get(`/api/integrations/${integrationId}`)
    .set('host', HOST)
    .set('cookie', otherCookie)
    .expect(404);
  await request(runtime.platformApp)
    .post(`/api/integrations/${integrationId}/check`)
    .set('host', HOST)
    .set('cookie', otherCookie)
    .set('x-csrf-token', otherCsrf)
    .send({})
    .expect(404);
  await request(runtime.platformApp)
    .post(`/api/integrations/${integrationId}/rotate-secret`)
    .set('host', HOST)
    .set('cookie', otherCookie)
    .set('x-csrf-token', otherCsrf)
    .send({})
    .expect(404);

  const ownerSession = runtime.repository.createSession(owner.id);
  const ownerCookie = `zeroone_sso_session=${ownerSession}`;
  await request(runtime.platformApp)
    .post(`/api/integrations/${integrationId}/rotate-secret`)
    .set('host', HOST)
    .set('cookie', ownerCookie)
    .send({})
    .expect(403);
  const publicConfig = await request(runtime.platformApp)
    .get(`/api/integrations/${integrationId}`)
    .set('host', HOST)
    .set('cookie', ownerCookie)
    .expect(200);
  assert.equal(publicConfig.body.clientSecret, undefined);

  const rotated = await request(runtime.platformApp)
    .post(`/api/integrations/${integrationId}/rotate-secret`)
    .set('host', HOST)
    .set('cookie', ownerCookie)
    .set('x-csrf-token', csrfFor(ownerSession))
    .send({})
    .expect(200);
  assert.ok(rotated.body.clientSecret);
  assert.notEqual(rotated.body.clientSecret, client.clientSecret);

  const callback = await issueAuthorizationCode({ clientId: client.clientId });
  await tokenRequest({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    code: callback.searchParams.get('code'),
  }).expect(401);
  await tokenRequest({
    clientId: client.clientId,
    clientSecret: rotated.body.clientSecret,
    code: callback.searchParams.get('code'),
  }).expect(200);
});
