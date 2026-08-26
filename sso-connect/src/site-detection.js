import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_RESPONSE_BYTES = 256 * 1024;

function isBlockedIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
  );
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  const mappedHex = normalized.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isBlockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return (
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
  );
}

export function isBlockedAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

export function normalizeSiteUrl(input, { demoMode = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('请输入商家站点地址');
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('站点地址格式不正确');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('站点地址不能包含账号、密码或片段');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('站点地址只支持 HTTP 或 HTTPS');
  }
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(demoMode && isLoopback)) {
    throw new Error('真实商家站点必须使用 HTTPS');
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.origin;
}

async function resolveAllowedAddress(url, { demoMode }) {
  const hostname = url.hostname;
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  const isDemoLoopback = demoMode && ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  if (!records.length || (!isDemoLoopback && records.some(({ address }) => isBlockedAddress(address)))) {
    throw new Error('出于安全原因，不能探测内网或保留地址');
  }
  return records[0];
}

function requestPinnedJson(url, address, family, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 4_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'ZeroOne-SSO-Connect/0.1',
        ...headers,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
      lookup(_hostname, _options, callback) {
        callback(null, address, family);
      },
      ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
    }, (response) => {
      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (declaredLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(new Error('商家响应过大'));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('商家响应过大'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload = null;
        try { payload = JSON.parse(text); } catch { /* handled as unknown site */ }
        resolve({ status: response.statusCode, payload });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('商家站点连接超时')));
    request.once('error', reject);
    request.end(body);
  });
}

export async function assertSafeUrl(input, options = {}) {
  const url = input instanceof URL ? new URL(input) : new URL(String(input));
  if (url.username || url.password || url.hash) throw new Error('商家接口地址不安全');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('商家接口只支持 HTTP 或 HTTPS');
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(options.demoMode && isLoopback)) {
    throw new Error('真实商家接口必须使用 HTTPS');
  }
  const resolved = await resolveAllowedAddress(url, options);
  return { url, resolved };
}

export async function requestSafeJson(input, options = {}) {
  const { url, resolved } = await assertSafeUrl(input, options);
  return requestPinnedJson(url, resolved.address, resolved.family, options);
}

function statusData(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return payload.data && typeof payload.data === 'object' ? payload.data : payload;
}

export async function detectMerchantSite(siteUrl, options = {}) {
  const origin = normalizeSiteUrl(siteUrl, options);
  const url = new URL('/api/status', origin);
  const response = await requestSafeJson(url, options);
  if (response.status >= 300 && response.status < 400) {
    throw new Error('商家状态接口发生跳转，请填写最终站点地址');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`无法读取商家状态（HTTP ${response.status}）`);
  }

  const data = statusData(response.payload);
  if (data.zeroone_demo === true) {
    return { origin, type: 'demo', oidcEnabled: Boolean(data.oidc_enabled) };
  }
  if ('oidc_enabled' in data || 'oidcEnabled' in data) {
    return { origin, type: 'new-api', oidcEnabled: Boolean(data.oidc_enabled ?? data.oidcEnabled) };
  }
  if ('oidc' in data) {
    return { origin, type: 'one-api', oidcEnabled: Boolean(data.oidc) };
  }
  return { origin, type: 'custom', oidcEnabled: false };
}

export function callbackFor(origin) {
  return new URL('/oauth/oidc', origin).href;
}
