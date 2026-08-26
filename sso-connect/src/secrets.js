import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from 'jose';

function randomBase64Url(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function requireBase64Key(value, name, minimumBytes = 32) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64url').length < minimumBytes) {
    throw new Error(`secrets.json 中的 ${name} 无效`);
  }
}

function validateSecrets(secrets) {
  if (!secrets || typeof secrets !== 'object') throw new Error('secrets.json 格式无效');
  requireBase64Key(secrets.cookieKey, 'cookieKey');
  requireBase64Key(secrets.databaseKey, 'databaseKey');
  requireBase64Key(secrets.pairwiseSalt, 'pairwiseSalt');
  requireBase64Key(secrets.registrationToken, 'registrationToken', 48);
  requireBase64Key(secrets.handoffAudienceSalt, 'handoffAudienceSalt');
  const jwk = secrets.jwks?.keys?.[0];
  if (!jwk || jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || !jwk.kid || !jwk.n || !jwk.e || !jwk.d) {
    throw new Error('secrets.json 中的签名 JWK 无效');
  }
  return secrets;
}

async function readExisting(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    await chmod(filePath, 0o600);
    return validateSecrets(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    await handle.close();
  }
}

export async function loadOrCreateSecrets(filePath) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const existing = await readExisting(filePath);
  if (existing) return existing;

  const { privateKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  const privateJwk = await exportJWK(privateKey);
  privateJwk.use = 'sig';
  privateJwk.alg = 'RS256';
  privateJwk.kid = await calculateJwkThumbprint(privateJwk);

  const secrets = {
    cookieKey: randomBase64Url(),
    databaseKey: randomBase64Url(),
    pairwiseSalt: randomBase64Url(),
    registrationToken: randomBase64Url(48),
    handoffAudienceSalt: randomBase64Url(),
    jwks: { keys: [privateJwk] },
  };

  const temporary = `${filePath}.${process.pid}.${randomBase64Url(8)}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(secrets, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temporary, filePath);
    await chmod(filePath, 0o600);
    await unlink(temporary);
    await syncDirectory(directory);
    return validateSecrets(secrets);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error.code === 'EEXIST') {
      const winner = await readExisting(filePath);
      if (winner) return winner;
    }
    throw error;
  }
}
