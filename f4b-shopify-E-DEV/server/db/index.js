const knex = require('knex');
const knexConfig = require('./knex.config');

/**
 * @type import("knex").Knex
 */
exports.db = knex(knexConfig);

exports.tables = {
  shopifyConfig: 'shopify_config',
  shopifyOrder: 'shopify_order',
  shopifyRefund: 'shopify_refund',
  shopifyGdprRequest: 'shopify_gdpr_request',
  getpaidTransaction: 'getpaid_transaction',
  getpaidOrder: 'getpaid_order',
  progressGuard: 'progress_guard',
};
