require('dotenv').config();

exports.config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000,
  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    scopes: 'write_payment_sessions,write_payment_gateways',
    appHost: process.env.SHOPIFY_APP_HOST || 'sh-ecommerce-integrations.flutterwave.com',
  },
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'flwrave',
    pool: {
      min: Number(process.env.DB_POOL_MIN || 0),
      max: Number(process.env.DB_POOL_MAX || 10),
    },
  },
  appBaseURL: `https://${process.env.SHOPIFY_APP_HOST}`,
  encryptionKey: process.env.ENCRYPTION_KEY || 'zk3YHBGQXbbzcdaTbR2JOUaoB1aPddXuJWHgQL-8xyeA94d8',
  cc: {
    apiUrl: process.env.CC_API_URL || 'http://rave-cc-api-staging.herokuapp.com',
    testApiUrl: process.env.CC_TEST_API_URL || 'http://rave-cc-api-staging.herokuapp.com',
    secret:
      process.env.CC_SECRET || 'yHjYf2CUCB8sVHzcUkZaAmYi9gazKq2IFA4CeF7-M6uIozJz55cIwTKztOAnyncg',
  },
  f4b: {
    apiUrl: process.env.F4B_API_URL || 'https://rave-api-v2.herokuapp.com',
    testApiUrl: process.env.F4B_API_URL || 'https://rave-api-v2.herokuapp.com',
    secret:
      process.env.F4B_SECRET || 'oT-0jZcOMQNmXOiZu04_vPuzENxaFqNgaAFevfpbv16mSTtm4yq6H6SCmdIlyrU8',
  },
  logging: {
    disableRequestLogger: Boolean(Number(process.env.DISABLE_REQ_LOGGER)) || false,
    level: process.env.LOG_LEVEL || 'info',
  },
  backfillToken: process.env.BACKFILL_TOKEN || 'VnrE9EbE05J7STpmHWO8Y66NFRPLTuL-Ud7J82uzwz7481segs',
};
