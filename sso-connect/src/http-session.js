import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { parse, serialize } from 'cookie';

const SESSION_COOKIE = 'zeroone_sso_session';
const VISITOR_COOKIE = 'zeroone_sso_visitor';
const REFERRAL_COOKIE = 'zeroone_sso_referral';

function cookieOptions(config, maxAge) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.production,
    path: '/',
    maxAge,
  };
}

function appendCookie(res, value) {
  res.append('set-cookie', value);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHttpSession({ config, repository, secrets }) {
  const csrfKey = Buffer.from(secrets.cookieKey, 'base64url');

  function csrfToken(sessionId) {
    if (!sessionId) return '';
    return createHmac('sha256', csrfKey).update(`csrf:${sessionId}`).digest('base64url');
  }

  function guestCsrfToken(visitorId) {
    if (!visitorId) return '';
    return createHmac('sha256', csrfKey).update(`guest:${visitorId}`).digest('base64url');
  }

  function setSession(res, id) {
    appendCookie(res, serialize(SESSION_COOKIE, id, cookieOptions(config, 8 * 60 * 60)));
  }

  function clearSession(res) {
    appendCookie(res, serialize(SESSION_COOKIE, '', cookieOptions(config, 0)));
  }

  function middleware(req, _res, next) {
    req.zerooneCookies = parse(req.headers.cookie || '');
    req.sessionId = req.zerooneCookies[SESSION_COOKIE];
    req.user = repository.getSessionUser(req.sessionId);
    req.csrfToken = csrfToken(req.sessionId);
    next();
  }

  function ensureDemo(req, res) {
    if (req.user) return req.user;
    if (!config.demoMode) return undefined;
    const id = repository.createDemoSession();
    setSession(res, id);
    req.sessionId = id;
    req.user = repository.getSessionUser(id);
    req.csrfToken = csrfToken(id);
    return req.user;
  }

  function requireUser(req, res, next) {
    if (req.user) return next();
    if (config.demoMode) {
      ensureDemo(req, res);
      return next();
    }
    return res.status(401).json({ error: '请先登录零一智鉴' });
  }

  function requireCsrf(req, res, next) {
    const supplied = req.get('x-csrf-token') || req.body?.csrfToken;
    if (!req.sessionId || !safeEqual(supplied, csrfToken(req.sessionId))) {
      return res.status(403).json({ error: '页面已过期，请刷新后重试' });
    }
    return next();
  }

  function requireGuestCsrf(req, res, next) {
    const visitorId = req.zerooneCookies?.[VISITOR_COOKIE];
    const supplied = req.get('x-csrf-token') || req.body?.csrfToken;
    if (!visitorId || !safeEqual(supplied, guestCsrfToken(visitorId))) {
      return res.status(403).render('error', { title: '页面已过期', message: '请重新打开邀请链接后再试。' });
    }
    return next();
  }

  function ensureVisitor(req, res) {
    let id = req.zerooneCookies?.[VISITOR_COOKIE];
    if (!id) {
      id = randomBytes(18).toString('base64url');
      appendCookie(res, serialize(
        VISITOR_COOKIE,
        id,
        cookieOptions(config, 30 * 24 * 60 * 60),
      ));
    }
    return id;
  }

  function setReferral(res, visitId) {
    appendCookie(res, serialize(
      REFERRAL_COOKIE,
      visitId,
      cookieOptions(config, 30 * 24 * 60 * 60),
    ));
  }

  function referralVisit(req) {
    return req.zerooneCookies?.[REFERRAL_COOKIE];
  }

  return {
    clearSession,
    ensureDemo,
    ensureVisitor,
    guestCsrfToken,
    middleware,
    referralVisit,
    requireCsrf,
    requireGuestCsrf,
    requireUser,
    setReferral,
    setSession,
  };
}
