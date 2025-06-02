const { Shopify, ApiVersion } = require('@shopify/shopify-api');
const crypto = require('crypto');
const { config } = require('../config');
const { db, tables } = require('./db');
const utils = require('./utils');

const storeCallback = async (ses) => {
  if (!ses.shop) return false;
  const encryptedSession = await utils.encrypt(JSON.stringify(ses), config.encryptionKey);

  const [existing] = await db.select('id').from(tables.shopifyConfig).where({ shop: ses.shop });

  if (existing) {
    await db
      .update({ session: encryptedSession })
      .table(tables.shopifyConfig)
      .where({ id: existing.id });
  } else {
    await db.insert({ shop: ses.shop, session: encryptedSession }).into(tables.shopifyConfig);
  }

  return true;
};

const loadCallback = async (id) => {
  const shop = id.replace(/^offline_/gi, '');
  const [sessionData] = await db.select('session').from(tables.shopifyConfig).where({ shop });

  const decryptedSession =
    sessionData && sessionData.session
      ? await utils.decrypt(sessionData.session, config.encryptionKey)
      : null;

  return decryptedSession && JSON.parse(decryptedSession);
};

const deleteCallback = async (id) => {
  const shop = id.replace(/^offline_/gi, '');

  await db.update({ session: null }).table(tables.shopifyConfig).where({ shop });

  return true;
};

const handleWebhookRequest = async (topic, shop) => {
  if (topic === 'APP_UNINSTALLED') {
    await db
      .update({ session: null, access_token: null, keys: null, is_installed: 0 })
      .table(tables.shopifyConfig)
      .where({ shop });
  }
};

Shopify.Context.initialize({
  API_KEY: config.shopify.apiKey,
  API_SECRET_KEY: config.shopify.apiSecret,
  API_VERSION: '2023-10',
  HOST_NAME: config.shopify.appHost,
  SCOPES: config.shopify.scopes,
  IS_EMBEDDED_APP: false,
  SESSION_STORAGE: new Shopify.Session.CustomSessionStorage(
    storeCallback,
    loadCallback,
    deleteCallback,
  ),
});

Shopify.Webhooks.Registry.addHandler('APP_UNINSTALLED', {
  path: '/api/webhooks',
  webhookHandler: handleWebhookRequest,
});

exports.verifyHmac = (req, res, next) => {
  try {
    const generateHash = crypto
      .createHmac('sha256', Shopify.Context.API_SECRET_KEY)
      .update(JSON.stringify(req.body), 'utf8')
      .digest('base64');

    const hmac = req.headers['x-shopify-hmac-sha256'];
    if (!hmac) throw new Error('Missing shopify hmac');

    if (Shopify.Utils.safeCompare(generateHash, hmac)) {
      next();
    } else {
      return res.status(401).json({
        success: false,
        message: 'Unable to verify hmac',
      });
    }
  } catch (error) {
    console.error('error::[verifyHmac]::', error.message);
    res.status(401).json({
      success: false,
      message: 'Unable to verify hmac',
    });
  }
};

exports.Shopify = Shopify;
