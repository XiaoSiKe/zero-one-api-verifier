import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

import express from 'express';
import helmet from 'helmet';
import { importJWK, SignJWT } from 'jose';

import {
  assertSafeUrl,
  callbackFor,
  detectMerchantSite,
  normalizeSiteUrl,
  requestSafeJson,
} from './site-detection.js';
import { registerClient, rotateClientSecret } from './provider.js';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function displayType(kind) {
  return {
    demo: '本地演示商家',
    'new-api': 'New API',
    'one-api': 'One API',
    custom: '自研 OIDC',
    handoff: '签名交接',
  }[kind] || kind;
}

function publicIntegration(row, config, clientSecret) {
  const oneApiDiscovery = `${config.issuer}/compat/one-api/.well-known/openid-configuration`;
  const startUrl = `${config.issuer}/sso/merchants/${row.id}/start`;
  return {
    id: row.id,
    status: row.status,
    type: row.kind,
    typeLabel: displayType(row.kind),
    clientId: row.client_id,
    ...(clientSecret ? { clientSecret } : {}),
    issuer: config.issuer,
    discoveryUrl: row.kind === 'one-api'
      ? oneApiDiscovery
      : `${config.issuer}/.well-known/openid-configuration`,
    redirectUri: row.redirect_uri,
    startUrl,
    legacyNoPkce: row.kind === 'new-api' || row.kind === 'one-api',
    message: row.failure_reason || undefined,
  };
}

function assertRedirectOrigin(redirectUrl, expectedOrigin) {
  const parsed = new URL(redirectUrl);
  if (parsed.origin !== expectedOrigin) {
    throw new Error('商家返回了未登记域名的跳转地址');
  }
  return parsed.href;
}

function rateLimit({ limit, windowMs }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > 10_000) {
      for (const [candidate, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(candidate);
      }
    }
    if (bucket.count > limit) {
      res.setHeader('retry-after', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: '操作过于频繁，请稍后重试' });
    }
    return next();
  };
}

export function createPlatformApp({
  config,
  database,
  provider,
  repository,
  httpSession,
  secrets,
  demoMerchant,
  publicDir,
  viewsDir,
}) {
  const app = express();
  const jsonBody = express.json({ limit: '16kb' });
  const formBody = express.urlencoded({ extended: false, limit: '16kb' });
  const integrationLimit = rateLimit({ limit: 10, windowMs: 60_000 });
  const authLimit = rateLimit({ limit: 30, windowMs: 60_000 });
  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1);
  app.set('views', viewsDir);
  app.set('view engine', 'ejs');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(express.static(publicDir));
  app.use(httpSession.middleware);

  app.use((_req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, demoMode: config.demoMode }));

  app.get('/', (_req, res) => res.redirect('/connect'));

  app.get('/connect', (req, res) => {
    const user = httpSession.ensureDemo(req, res);
    if (!user) {
      return res.status(401).render('error', {
        title: '需要平台账号',
        message: '当前脚手架未连接正式用户系统；请使用 Demo 模式进行本地实验。',
      });
    }
    if (req.query.success === '1') {
      const demo = repository.findIntegrationByOrigin(config.demoMerchantOrigin);
      if (demo) repository.updateIntegration(demo.id, { status: 'enabled', failureReason: null });
    }
    return res.render('connect', {
      demo: req.query.demo === '1' || config.demoMode,
      siteUrl: req.query.demo === '1' ? config.demoMerchantOrigin : '',
      issuer: config.issuer,
      csrfToken: req.csrfToken,
    });
  });

  app.post(
    '/api/integrations',
    integrationLimit,
    jsonBody,
    httpSession.requireUser,
    httpSession.requireCsrf,
    async (req, res, next) => {
      let registeredClient;
      try {
        const rawRequestedType = req.body.type;
        const requestedType = ['auto', 'demo', '', undefined].includes(rawRequestedType)
          ? undefined
          : (rawRequestedType === 'oidc' ? 'custom' : rawRequestedType);
        let detection;
        if (requestedType === 'handoff') {
          const origin = normalizeSiteUrl(req.body.siteUrl, { demoMode: config.demoMode });
          await assertSafeUrl(new URL('/zeroone/sso/handoff', origin), { demoMode: config.demoMode });
          detection = { origin, type: 'custom', oidcEnabled: false };
        } else {
          detection = await detectMerchantSite(req.body.siteUrl, {
            demoMode: config.demoMode,
          });
        }
        if (detection.type === 'custom' && !requestedType) {
          return res.status(422).json({
            error: 'unsupported_type',
            message: '没有自动识别出系统类型，请选择 New API、One API、自研 OIDC 或签名接口。',
          });
        }
        const kind = requestedType === 'handoff'
          ? 'handoff'
          : (detection.type === 'custom' && requestedType ? requestedType : detection.type);
        const existing = repository.findIntegrationByOrigin(detection.origin);
        if (existing) {
          if (existing.owner_user_id !== req.user.id) {
            return res.status(409).json({
              error: 'integration_owned',
              message: '该站点已经由其他商家账号接入。',
            });
          }
          if (existing.kind === 'demo' && demoMerchant) {
            demoMerchant.configure({
              issuer: config.issuer,
              clientId: existing.client_id,
              clientSecret: repository.integrationSecret(existing),
              redirectUri: existing.redirect_uri,
            });
          }
          return res.json(publicIntegration(existing, config));
        }

        const id = randomUUID();
        const redirectUri = callbackFor(detection.origin);
        const isDemo = detection.origin === config.demoMerchantOrigin;
        let clientId = `handoff_${randomBytes(18).toString('base64url')}`;
        let clientSecret;
        if (kind !== 'handoff') {
          registeredClient = await registerClient(provider, {
            name: `零一智鉴 · ${displayType(kind)}`,
            redirectUri,
            template: kind,
            integrationId: id,
            trusted: isDemo,
          });
          ({ clientId, clientSecret } = registeredClient);
        }
        const row = repository.saveIntegration({
          id,
          ownerUserId: req.user.id,
          siteUrl: req.body.siteUrl,
          origin: detection.origin,
          kind,
          clientId,
          clientSecret,
          redirectUri,
          startUrl: isDemo ? `${detection.origin}/sso/zeroone/start` : `${detection.origin}/login`,
          handoffUrl: kind === 'handoff' ? `${detection.origin}/zeroone/sso/handoff` : null,
          status: isDemo
            ? 'ready'
            : ((kind === 'handoff' || detection.oidcEnabled) ? 'ready_for_test' : 'awaiting_configuration'),
        });

        if (isDemo && demoMerchant) {
          demoMerchant.configure({ issuer: config.issuer, clientId, clientSecret, redirectUri });
        }
        repository.audit('merchant.integration.created', {
          actorId: req.user.id,
          merchantId: id,
          details: { kind, origin: detection.origin },
        });
        return res.status(201).json(publicIntegration(row, config, clientSecret));
      } catch (error) {
        if (registeredClient?.clientId) {
          await provider.Client.adapter.destroy(registeredClient.clientId);
        }
        return next(error);
      }
    },
  );

  app.get('/api/integrations/:id', httpSession.requireUser, (req, res) => {
    const row = repository.getIntegrationForOwner(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: '未找到该接入配置' });
    return res.json(publicIntegration(row, config));
  });

  app.post(
    '/api/integrations/:id/check',
    jsonBody,
    httpSession.requireUser,
    httpSession.requireCsrf,
    async (req, res, next) => {
      try {
        const row = repository.getIntegrationForOwner(req.params.id, req.user.id);
        if (!row) return res.status(404).json({ error: '未找到该接入配置' });
        const detection = await detectMerchantSite(row.normalized_origin, { demoMode: config.demoMode });
        const status = detection.oidcEnabled
          ? (row.status === 'enabled' ? 'enabled' : 'ready_for_test')
          : 'awaiting_configuration';
        const updated = repository.updateIntegration(row.id, {
          status,
          failureReason: detection.oidcEnabled ? null : '请在商家后台启用 OIDC 登录与注册',
          lastCheckedAt: nowSeconds(),
        });
        return res.json(publicIntegration(updated, config));
      } catch (error) {
        repository.updateIntegration(req.params.id, {
          status: 'failed',
          failureReason: error.message,
          lastCheckedAt: nowSeconds(),
        });
        return next(error);
      }
    },
  );

  app.post(
    '/api/integrations/:id/rotate-secret',
    jsonBody,
    httpSession.requireUser,
    httpSession.requireCsrf,
    async (req, res, next) => {
      try {
        const row = repository.getIntegrationForOwner(req.params.id, req.user.id);
        if (!row) return res.status(404).json({ error: '未找到该接入配置' });
        if (row.kind === 'handoff') return res.status(400).json({ error: '签名交接模式没有 Client Secret' });
        const rotated = await rotateClientSecret(provider, row.client_id);
        const updated = repository.rotateIntegrationSecret(row.id, rotated.clientSecret);
        if (updated.kind === 'demo' && demoMerchant) {
          demoMerchant.configure({
            issuer: config.issuer,
            clientId: updated.client_id,
            clientSecret: rotated.clientSecret,
            redirectUri: updated.redirect_uri,
          });
        }
        repository.audit('merchant.secret.rotated', {
          actorId: req.user.id,
          merchantId: row.id,
        });
        return res.json(publicIntegration(updated, config, rotated.clientSecret));
      } catch (error) {
        return next(error);
      }
    },
  );

  app.get('/sso/merchants/:id/start', httpSession.requireUser, async (req, res, next) => {
    try {
      const integration = repository.getIntegration(req.params.id);
      if (!integration) return res.status(404).render('error', { title: '商家不存在', message: '未找到该商家接入配置。' });
      if (!['ready', 'ready_for_test', 'enabled'].includes(integration.status)) {
        return res.status(409).render('error', {
          title: '商家尚未完成接入',
          message: '请先完成配置检查，再发起一键登录。',
        });
      }

      if (integration.kind !== 'handoff') {
        return res.redirect(integration.start_url || `${integration.normalized_origin}/login`);
      }

      const privateJwk = secrets.jwks.keys[0];
      const key = await importJWK(privateJwk, 'RS256');
      const subject = createHmac('sha256', Buffer.from(secrets.pairwiseSalt, 'base64url'))
        .update(integration.id)
        .update('\0')
        .update(req.user.id)
        .digest('base64url');
      const jti = randomUUID();
      const token = await new SignJWT({
        sub: subject,
        email: req.user.email,
        email_verified: true,
        name: req.user.display_name,
      })
        .setProtectedHeader({ alg: 'RS256', kid: privateJwk.kid, typ: 'JWT' })
        .setIssuer(config.issuer)
        .setAudience(integration.normalized_origin)
        .setJti(jti)
        .setIssuedAt()
        .setExpirationTime('60s')
        .sign(key);
      const response = await requestSafeJson(integration.handoff_url, {
        demoMode: config.demoMode,
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
        timeoutMs: 5_000,
      });
      const payload = response.payload;
      if (response.status < 200 || response.status >= 300 || payload?.success !== true || !payload.redirect_url) {
        throw new Error(payload?.error || '商家签名交接失败');
      }
      if (payload.external_user_id) {
        database.prepare(`
          INSERT INTO handoff_bindings (id, merchant_id, user_id, subject, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (merchant_id, user_id) DO UPDATE SET subject = excluded.subject
        `).run(randomUUID(), integration.id, req.user.id, payload.external_user_id, nowSeconds());
      }
      repository.audit('sso.handoff.succeeded', {
        actorId: req.user.id,
        merchantId: integration.id,
        details: { jti },
      });
      return res.redirect(assertRedirectOrigin(payload.redirect_url, integration.normalized_origin));
    } catch (error) {
      return next(error);
    }
  });

  app.get('/interaction/:uid', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const { prompt, params } = details;
      const client = await provider.Client.find(params.client_id);
      if (!client) throw new Error('OIDC Client 不存在');
      if (client.zeroone_integration_id) {
        const integration = repository.getIntegration(client.zeroone_integration_id);
        if (!integration || !['ready', 'ready_for_test', 'enabled'].includes(integration.status)) {
          throw new Error('商家接入尚未通过配置检查');
        }
      } else if (client.zeroone_trusted !== true) {
        throw new Error('OIDC Client 尚未经过平台登记');
      }
      if (prompt.name === 'login') {
        const user = req.user || httpSession.ensureDemo(req, res);
        if (!user) {
          return res.status(401).render('auth', {
            title: '登录零一智鉴',
            message: '请先完成平台登录。',
            formAction: '',
            hiddenFields: [],
          });
        }
        await provider.interactionFinished(req, res, {
          login: { accountId: user.id },
        }, { mergeWithLastSubmission: false });
        return undefined;
      }
      if (prompt.name === 'consent') {
        if (client.zeroone_trusted !== true) {
          return res.render('auth', {
            clientName: client.clientName || '已接入商家',
            accountId: details.session.accountId,
            formAction: `/interaction/${encodeURIComponent(req.params.uid)}/confirm`,
            hiddenFields: { csrfToken: req.csrfToken },
          });
        }
        let grantId = details.grantId;
        let grant = grantId
          ? await provider.Grant.find(grantId)
          : new provider.Grant({ accountId: details.session.accountId, clientId: params.client_id });
        if (prompt.details.missingOIDCScope) {
          grant.addOIDCScope(prompt.details.missingOIDCScope.join(' '));
        }
        if (prompt.details.missingOIDCClaims) {
          grant.addOIDCClaims(prompt.details.missingOIDCClaims);
        }
        grantId = await grant.save();
        await provider.interactionFinished(req, res, {
          consent: details.grantId ? {} : { grantId },
        }, { mergeWithLastSubmission: true });
        return undefined;
      }
      throw new Error(`不支持的授权交互：${prompt.name}`);
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    '/interaction/:uid/confirm',
    formBody,
    httpSession.requireUser,
    httpSession.requireCsrf,
    async (req, res, next) => {
      try {
        const details = await provider.interactionDetails(req, res);
        if (details.prompt.name !== 'consent' || details.session.accountId !== req.user.id) {
          throw new Error('授权会话不匹配');
        }
        const client = await provider.Client.find(details.params.client_id);
        const integration = client?.zeroone_integration_id
          ? repository.getIntegration(client.zeroone_integration_id)
          : undefined;
        if (!client || !integration || !['ready', 'ready_for_test', 'enabled'].includes(integration.status)) {
          throw new Error('商家接入尚未通过配置检查');
        }
        let grantId = details.grantId;
        const grant = grantId
          ? await provider.Grant.find(grantId)
          : new provider.Grant({ accountId: details.session.accountId, clientId: details.params.client_id });
        if (details.prompt.details.missingOIDCScope) {
          grant.addOIDCScope(details.prompt.details.missingOIDCScope.join(' '));
        }
        if (details.prompt.details.missingOIDCClaims) {
          grant.addOIDCClaims(details.prompt.details.missingOIDCClaims);
        }
        grantId = await grant.save();
        await provider.interactionFinished(req, res, {
          consent: details.grantId ? {} : { grantId },
        }, { mergeWithLastSubmission: true });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get('/compat/one-api/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/oauth/authorize`,
      token_endpoint: `${config.issuer}/compat/one-api/token`,
      userinfo_endpoint: `${config.issuer}/oauth/userinfo`,
      jwks_uri: `${config.issuer}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: ['openid', 'profile', 'email'],
    });
  });

  app.post('/compat/one-api/token', authLimit, express.json({ limit: '8kb' }), async (req, res, next) => {
    try {
      const allowed = ['client_id', 'client_secret', 'code', 'grant_type', 'redirect_uri'];
      if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some((key) => !allowed.includes(key))) {
        return res.status(400).json({ error: 'invalid_request' });
      }
      const params = new URLSearchParams();
      for (const key of allowed) {
        if (req.body[key] != null) {
          if (typeof req.body[key] !== 'string') return res.status(400).json({ error: 'invalid_request' });
          params.set(key, req.body[key]);
        }
      }
      const upstream = await fetch(`${config.internalOrigin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: AbortSignal.timeout(5_000),
      });
      const body = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(body);
    } catch (error) {
      next(error);
    }
  });

  app.get('/i/:code', authLimit, (req, res) => {
    const visitorId = httpSession.ensureVisitor(req, res);
    const existingVisit = httpSession.referralVisit(req);
    const validExisting = existingVisit
      ? database.prepare('SELECT * FROM invite_visits WHERE id = ? AND expires_at > ?').get(existingVisit, nowSeconds())
      : undefined;
    const visit = validExisting || repository.recordInviteVisit(req.params.code, visitorId);
    if (!visit) return res.status(404).render('error', { title: '邀请链接无效', message: '请向邀请人获取新的链接。' });
    if (!validExisting) httpSession.setReferral(res, visit.id);
    return res.render('invite-register', {
      formAction: '/auth/demo-register',
      csrfToken: httpSession.guestCsrfToken(visitorId),
      inviteCode: req.params.code,
    });
  });

  app.post('/auth/demo-register', authLimit, formBody, httpSession.requireGuestCsrf, (req, res, next) => {
    try {
      if (!config.demoMode) throw new Error('模拟验证只在 Demo 模式开放');
      const result = repository.startEmailVerification(req.body.email, httpSession.referralVisit(req));
      return res.render('auth', {
        clientName: '本地模拟验证',
        formAction: '/auth/demo-verify',
        hiddenFields: {
          token: result.rawToken,
          csrfToken: req.body.csrfToken,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/auth/demo-verify', formBody, httpSession.requireGuestCsrf, (req, res, next) => {
    try {
      if (!config.demoMode) throw new Error('模拟验证只在 Demo 模式开放');
      const result = repository.verifyEmail(req.body.token);
      httpSession.setSession(res, result.sessionId);
      return res.redirect('/invites?verified=1');
    } catch (error) {
      return next(error);
    }
  });

  app.get('/invites', httpSession.requireUser, (req, res) => {
    res.render('invites', {
      user: req.user,
      csrfToken: req.csrfToken,
      inviteBaseUrl: `${config.issuer}/i/`,
    });
  });

  app.get('/api/me/invites/summary', httpSession.requireUser, (req, res) => {
    res.json(repository.inviteSummary(req.user.id));
  });

  app.get('/api/me/invites/registrations', httpSession.requireUser, (req, res) => {
    res.json({ registrations: repository.inviteRegistrations(req.user.id) });
  });

  app.use('/oauth/authorize', authLimit);
  app.use('/oauth/token', authLimit);
  app.use(provider.callback());

  app.use((error, req, res, _next) => {
    repository.audit('request.failed', {
      actorId: req.user?.id,
      merchantId: req.params?.id,
      details: { path: req.path, message: error.message },
    });
    if (req.path.startsWith('/api/') || req.path.startsWith('/compat/')) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(400).render('error', { title: '操作失败', message: error.message });
  });

  return app;
}
