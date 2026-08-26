import { createHmac, randomBytes } from 'node:crypto';

import Provider from 'oidc-provider';

function randomId(prefix, bytes = 18) {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function pairwiseSubject(salt, accountId, client) {
  const sector = client.sectorIdentifier || client.clientId;
  return createHmac('sha256', Buffer.from(salt, 'base64url'))
    .update(sector)
    .update('\0')
    .update(accountId)
    .digest('base64url');
}

export function createOidcProvider({ config, database, Adapter, secrets }) {
  const provider = new Provider(config.issuer, {
    adapter: Adapter,
    clientAuthMethods: ['client_secret_post'],
    clockTolerance: 0,
    clients: [],
    claims: {
      email: ['email', 'email_verified'],
      profile: ['name', 'preferred_username'],
    },
    conformIdTokenClaims: false,
    extraClientMetadata: {
      properties: [
        'zeroone_template',
        'zeroone_legacy_no_pkce',
        'zeroone_integration_id',
        'zeroone_trusted',
      ],
      validator(_ctx, key, value) {
        if (key === 'zeroone_template' && !['demo', 'new-api', 'one-api', 'custom'].includes(value)) {
          throw new TypeError('unsupported zeroone_template');
        }
        if (key === 'zeroone_legacy_no_pkce' && typeof value !== 'boolean') {
          throw new TypeError('zeroone_legacy_no_pkce must be boolean');
        }
        if (key === 'zeroone_integration_id' && value !== undefined && typeof value !== 'string') {
          throw new TypeError('zeroone_integration_id must be a string');
        }
        if (key === 'zeroone_trusted' && typeof value !== 'boolean') {
          throw new TypeError('zeroone_trusted must be boolean');
        }
      },
    },
    features: {
      devInteractions: { enabled: false },
      dPoP: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      registration: { enabled: false },
      resourceIndicators: { enabled: false },
      revocation: { enabled: false },
      userinfo: { enabled: true },
      rpInitiatedLogout: { enabled: false },
    },
    findAccount: async (_ctx, accountId) => {
      const user = database.prepare(
        'SELECT id, email, display_name, email_verified FROM users WHERE id = ?',
      ).get(accountId);
      if (!user || !user.email_verified) return undefined;
      return {
        accountId: user.id,
        async claims() {
          const name = user.display_name || user.email.split('@')[0];
          return {
            sub: user.id,
            email: user.email,
            email_verified: true,
            name,
            preferred_username: name,
          };
        },
      };
    },
    jwks: secrets.jwks,
    pairwiseIdentifier: async (_ctx, accountId, client) => (
      pairwiseSubject(secrets.pairwiseSalt, accountId, client)
    ),
    pkce: {
      required(_ctx, client) {
        return client.zeroone_legacy_no_pkce !== true;
      },
    },
    responseTypes: ['code'],
    renderError(ctx, out) {
      ctx.type = 'html';
      ctx.body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SSO 授权失败 · 零一智鉴</title></head><body><main><h1>SSO 授权失败</h1><p>${escapeHtml(out.error_description || out.error)}</p><a href="/connect">返回接入页</a></main></body></html>`;
    },
    routes: {
      authorization: '/oauth/authorize',
      jwks: '/.well-known/jwks.json',
      token: '/oauth/token',
      userinfo: '/oauth/userinfo',
    },
    scopes: ['openid', 'profile', 'email'],
    subjectTypes: ['pairwise'],
    ttl: {
      AccessToken: 5 * 60,
      AuthorizationCode: 60,
      Grant: 24 * 60 * 60,
      IdToken: 5 * 60,
      Interaction: 10 * 60,
      Session: 8 * 60 * 60,
    },
    cookies: {
      keys: [secrets.cookieKey],
      long: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
        signed: true,
      },
      short: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
        signed: true,
      },
    },
  });

  if (config.production) provider.proxy = true;
  return provider;
}

export async function registerClient(provider, {
  name,
  redirectUri,
  template,
  integrationId,
  trusted = false,
}) {
  const clientId = randomId('zeroone');
  const clientSecret = randomBytes(32).toString('base64url');
  const legacyNoPkce = template === 'new-api' || template === 'one-api';
  const metadata = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: name,
    application_type: 'web',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    subject_type: 'pairwise',
    zeroone_template: template,
    zeroone_legacy_no_pkce: legacyNoPkce,
    ...(integrationId ? { zeroone_integration_id: integrationId } : {}),
    zeroone_trusted: trusted,
  };
  await provider.Client.validate(metadata);
  await provider.Client.adapter.upsert(clientId, metadata);
  return { clientId, clientSecret, metadata, legacyNoPkce };
}

export async function rotateClientSecret(provider, clientId) {
  const metadata = await provider.Client.adapter.find(clientId);
  if (!metadata) throw new Error('OIDC Client 不存在');
  const clientSecret = randomBytes(32).toString('base64url');
  const updated = { ...metadata, client_secret: clientSecret };
  await provider.Client.validate(updated);
  await provider.Client.adapter.upsert(clientId, updated);
  return { clientId, clientSecret };
}

export { pairwiseSubject };
