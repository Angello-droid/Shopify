const express = require('express');
const next = require('next');
const path = require('path');

const { config } = require('../config');
const {
  handlePaymentRedirect,
  handlePaymentInit,
  handleRefundInit,
  handleUpdateSettings,
  handleFetchSettings,
  handleAuthInit,
  handleAuthCallback,
  handleAppHome,
  handleWebhooks,
  handleGdprHooks,
  handlePaymentCallback,
  handlePendingPaymentsBackfill,
} = require('./handlers');
const { clearshopifyRefunds } = require('./jobs');
const { verifyHmac } = require('./shopify');
const { handleAsyncErrors } = require('./utils');
const { logger } = require('../logger');

const app = express();

// !NOTE: THIS ROUTE MAPPING IS HERE ON PURPOSE
// ! see here: https://github.com/Shopify/shopify-api-node/issues/167#issuecomment-1018852152
app.post('/api/webhooks', handleWebhooks);

app.use(express.json());

const nextApp = next({
  dev: config.nodeEnv === 'development',
  dir: path.join(process.cwd(), 'ui'),
  conf: { reactStrictMode: true },
});

let refundsInterval;

async function main() {
  await nextApp.prepare();
  const nextHandler = nextApp.getRequestHandler();

  app.get('/ping', (req, res) =>
    res.json({ success: true, message: 'pong', data: { ts: new Date() } }),
  );

  app.post('/api/payment', handleAsyncErrors(handlePaymentInit));
  app.get('/api/payment/:shop/redirect', handleAsyncErrors(handlePaymentRedirect));
  app.post('/api/payment/callback', handleAsyncErrors(handlePaymentCallback));
  app.post('/api/refund', handleAsyncErrors(handleRefundInit));
  app.post('/api/settings', handleAsyncErrors(handleUpdateSettings));
  app.get('/api/settings', handleAsyncErrors(handleFetchSettings));
  app.post('/api/webhooks/gdpr/:topic', verifyHmac, handleAsyncErrors(handleGdprHooks));
  app.post('/api/pending-payments/backfill', handleAsyncErrors(handlePendingPaymentsBackfill));
  app.get('/auth', handleAsyncErrors(handleAuthInit));
  app.get('/auth/callback', handleAsyncErrors(handleAuthCallback));
  app.get('/', handleAppHome(nextHandler));
  app.all('*', (req, res) => nextHandler(req, res));
  app.use((err, req, res, next) => {
    logger.error(err, 'unhandled/uncaught error');
    return res.status(500).json({
      success: false,
      message: 'An internal error occurred processing your request',
      data: null,
    });
  });

  const intervalEntropy = Math.floor(Math.random() * 1000) + 1000;
  const interval = 58000 + intervalEntropy; // every 58 - 60 secs
  refundsInterval = setInterval(() => {
    clearshopifyRefunds().catch((e) => logger.error(e, 'pending refunds check error'));
  }, interval);

  // start app inline
  app.listen(config.port, () => logger.info(`app up on port ${config.port}`));
}

main().catch((e) => {
  clearInterval(refundsInterval);
  logger.error(e, 'shopify app main() error');
});
