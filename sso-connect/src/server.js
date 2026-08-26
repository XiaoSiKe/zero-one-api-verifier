import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { createDatabase, closeDatabase } from './database.js';
import { createOidcAdapter } from './oidc-adapter.js';
import { loadConfig, MODULE_DIR } from './config.js';
import { loadOrCreateSecrets } from './secrets.js';
import { createOidcProvider } from './provider.js';
import { createRepository } from './repository.js';
import { createHttpSession } from './http-session.js';
import { createDemoMerchant } from './demo-merchant.js';
import { createPlatformApp } from './platform-app.js';

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

export async function createRuntime(overrides = {}) {
  const config = loadConfig(overrides);
  const secrets = await loadOrCreateSecrets(config.secretsPath);
  const database = createDatabase(config.databasePath);
  const Adapter = createOidcAdapter({
    database,
    encryptionKey: secrets.databaseKey,
  });
  const provider = createOidcProvider({ config, database, Adapter, secrets });
  const repository = createRepository(database, secrets);
  const integrations = database.prepare('SELECT * FROM merchant_integrations').all();
  for (const integration of integrations) {
    const metadata = await provider.Client.adapter.find(integration.client_id);
    if (!metadata) continue;
    const isDemoIntegration = integration.normalized_origin === config.demoMerchantOrigin;
    const upgraded = {
      ...metadata,
      zeroone_integration_id: integration.id,
      zeroone_trusted: isDemoIntegration,
      ...(isDemoIntegration ? {
        zeroone_template: 'demo',
        zeroone_legacy_no_pkce: false,
      } : {}),
    };
    await provider.Client.validate(upgraded);
    await provider.Client.adapter.upsert(integration.client_id, upgraded);
    if (isDemoIntegration && integration.kind !== 'demo') {
      database.prepare(
        "UPDATE merchant_integrations SET kind = 'demo', updated_at = ? WHERE id = ?",
      ).run(Math.floor(Date.now() / 1000), integration.id);
    }
  }
  const httpSession = createHttpSession({ config, repository, secrets });
  const publicDir = path.join(MODULE_DIR, 'public');
  const viewsDir = path.join(MODULE_DIR, 'views');
  const demoMerchant = config.demoMode
    ? createDemoMerchant({ config, publicDir, viewsDir })
    : null;
  const artifactCleaner = new Adapter('Cleanup');
  await artifactCleaner.cleanupExpired();
  repository.cleanupExpired();
  demoMerchant?.cleanupExpired();
  const cleanupTimer = setInterval(() => {
    artifactCleaner.cleanupExpired().catch((error) => console.error('OIDC 过期数据清理失败', error));
    repository.cleanupExpired();
    demoMerchant?.cleanupExpired();
  }, 15 * 60 * 1000);
  cleanupTimer.unref();

  if (demoMerchant) {
    const integration = repository.findIntegrationByOrigin(config.demoMerchantOrigin);
    if (integration?.client_secret_ciphertext) {
      demoMerchant.configure({
        issuer: config.issuer,
        clientId: integration.client_id,
        clientSecret: repository.integrationSecret(integration),
        redirectUri: integration.redirect_uri,
      });
    }
  }

  const platformApp = createPlatformApp({
    config,
    database,
    provider,
    repository,
    httpSession,
    secrets,
    demoMerchant,
    publicDir,
    viewsDir,
  });

  return {
    Adapter,
    config,
    database,
    demoMerchant,
    platformApp,
    provider,
    repository,
    secrets,
    async close() {
      clearInterval(cleanupTimer);
      demoMerchant?.database.close();
      closeDatabase(database);
    },
  };
}

export async function startServers(overrides = {}) {
  const runtime = await createRuntime(overrides);
  const platformServer = await listen(
    runtime.platformApp,
    runtime.config.platformPort,
    runtime.config.platformHost,
  );
  let merchantServer;
  if (runtime.demoMerchant) {
    merchantServer = await listen(
      runtime.demoMerchant.app,
      runtime.config.merchantPort,
      runtime.config.merchantHost,
    );
  }

  const stop = async () => {
    await Promise.all([
      new Promise((resolve) => platformServer.close(resolve)),
      merchantServer
        ? new Promise((resolve) => merchantServer.close(resolve))
        : Promise.resolve(),
    ]);
    await runtime.close();
  };

  return { ...runtime, platformServer, merchantServer, stop };
}

async function main() {
  const runtime = await startServers();
  console.log(`零一智鉴 SSO 接入页：${runtime.config.issuer}/connect?demo=1`);
  if (runtime.demoMerchant) {
    console.log(`本地演示商家：${runtime.config.demoMerchantOrigin}`);
  }
  const shutdown = async () => {
    await runtime.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
