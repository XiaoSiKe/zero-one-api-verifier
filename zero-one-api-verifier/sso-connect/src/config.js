import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readBoolean(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readPort(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

export function loadConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const platformPort = overrides.platformPort ?? readPort(process.env.SSO_PORT, 8020);
  const merchantPort = overrides.merchantPort ?? readPort(process.env.SSO_DEMO_MERCHANT_PORT, 8021);
  const issuer = overrides.issuer ?? process.env.SSO_ISSUER ?? `http://127.0.0.1:${platformPort}`;
  const demoMode = overrides.demoMode ?? readBoolean(process.env.SSO_DEMO_MODE, nodeEnv !== 'production');
  const dataDir = path.resolve(overrides.dataDir ?? process.env.SSO_DATA_DIR ?? path.join(MODULE_DIR, 'data'));

  if (nodeEnv === 'production' && !issuer.startsWith('https://')) {
    throw new Error('生产环境的 SSO_ISSUER 必须使用 HTTPS');
  }
  if (nodeEnv === 'production' && demoMode) {
    throw new Error('生产环境禁止启用 SSO_DEMO_MODE');
  }

  return {
    nodeEnv,
    production: nodeEnv === 'production',
    demoMode,
    issuer: issuer.replace(/\/$/, ''),
    platformHost: overrides.platformHost ?? process.env.SSO_HOST ?? '127.0.0.1',
    platformPort,
    merchantHost: overrides.merchantHost ?? process.env.SSO_DEMO_MERCHANT_HOST ?? '127.0.0.1',
    merchantPort,
    internalOrigin: overrides.internalOrigin ?? `http://127.0.0.1:${platformPort}`,
    demoMerchantOrigin: overrides.demoMerchantOrigin ?? `http://127.0.0.1:${merchantPort}`,
    dataDir,
    databasePath: overrides.databasePath ?? path.join(dataDir, 'zeroone-sso.sqlite3'),
    merchantDatabasePath: overrides.merchantDatabasePath ?? path.join(dataDir, 'demo-merchant.sqlite3'),
    secretsPath: overrides.secretsPath ?? path.join(dataDir, 'secrets.json'),
  };
}

export { MODULE_DIR };
