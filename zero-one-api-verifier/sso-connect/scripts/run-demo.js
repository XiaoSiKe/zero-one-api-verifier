process.env.SSO_DEMO_MODE = '1';
const { startServers } = await import('../src/server.js');
const runtime = await startServers();
console.log(`零一智鉴 SSO 接入页：${runtime.config.issuer}/connect?demo=1`);
console.log(`本地演示商家：${runtime.config.demoMerchantOrigin}`);

const shutdown = async () => {
  await runtime.stop();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
