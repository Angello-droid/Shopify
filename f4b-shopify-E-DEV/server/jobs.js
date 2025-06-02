const { default: axios } = require('axios');
const { gql } = require('graphql-request');

const { config } = require('../config');
const { db, tables } = require('./db');
const utils = require('./utils');
const { logger } = require('../logger');
const FIVE_MINUTES_MS = 300000;

exports.clearshopifyRefundsOriginal = async () => {
  const [shopifyRefund] = await db
    .select('*')
    .from(tables.shopifyRefund)
    .whereRaw(`status = "pending" AND retry_ts IS NOT NULL AND retry_ts <= ${Date.now()}`)
    .orderBy('retry_ts', 'asc')
    .limit(1);

  if (!shopifyRefund) return;

  let guarded = false;

  try {
    await db
      .insert({
        entity: `${shopifyRefund.refund_id}-${shopifyRefund.retry_ts}`,
        entity_type: 'SHRFD',
        createdAt: db.raw('CURRENT_TIMESTAMP'),
        updatedAt: db.raw('CURRENT_TIMESTAMP'),
      })
      .into(tables.progressGuard);
  } catch (error) {
    guarded = true;
  }

  if (guarded) return;

  const gid = shopifyRefund.gid;
  logger.info(`reattempting refund for ${gid}`);

  const [[shopConfig], [gpTx]] = await Promise.all([
    db.select('*').from(tables.shopifyConfig).where({ shop: shopifyRefund.shop }),
    db
      .select(['id', 'flwRef', 'amount', 'currency', 'AccountId'])
      .from(tables.getpaidTransaction)
      .where({ id: shopifyRefund.gptxid }),
  ]);

  const token = await utils.decrypt(shopConfig.access_token, config.encryptionKey);
  const client = utils.getGqlClient(shopifyRefund.shop, token);

  const rejectRefund = async (id, message, opts = {}) => {
    const mutation = gql`
      mutation RefundSessionReject($id: ID!, $reason: RefundSessionRejectionReasonInput!) {
        refundSessionReject(id: $id, reason: $reason) {
          refundSession {
            id
            status {
              code
              reason {
                ... on RefundSessionStatusReason {
                  code
                  merchantMessage
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      id,
      reason: {
        code: 'PROCESSING_ERROR',
        merchantMessage: message,
      },
    };

    let res = null;
    try {
      res = await client.request(mutation, variables);
    } catch (error) {
      // TODO: log this
    }

    const updateObj = { status: 'rejected' };
    if (opts.meta) updateObj.meta = opts.meta;

    await db.update(updateObj).table(tables.shopifyRefund).where({ id: shopifyRefund.id });
    return res;
  };

  const resolveRefund = async (id, opts = {}) => {
    const mutation = gql`
      mutation RefundSessionResolve($id: ID!) {
        refundSessionResolve(id: $id) {
          refundSession {
            id
            status {
              code
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    let res = null;
    try {
      res = await client.request(mutation, { id });
    } catch (error) {
      // TODO: log this
    }

    const updateObj = { status: 'resolved' };
    if (opts.meta) updateObj.meta = opts.meta;

    await db.update(updateObj).table(tables.shopifyRefund).where({ id: shopifyRefund.id });

    return res;
  };

  const meta = JSON.parse(shopifyRefund.meta);

  if (!meta) {
    // very very rare, but if happens, mark "invalid"
    return db.update({ status: null }).table(tables.shopifyRefund).where({ id: shopifyRefund.id });
  }

  if (meta.retryCount === meta.maxRetries) {
    await rejectRefund(gid, 'Unable to process refund', {
      meta: JSON.stringify(meta),
    });
  } else {
    meta.retryCount++;
  }

  if (meta.refundApiReqSuccessful) {
    return await resolveRefund(gid, {
      meta: utils.generateRefundMeta({
        ...meta,
      }),
    });
  }

  const keys = shopConfig && shopConfig.keys;
  const decryptedKeys = keys ? await utils.decrypt(keys, config.encryptionKey) : null;
  const parsedKeys = (decryptedKeys && JSON.parse(decryptedKeys)) || {};
  const isTest = Boolean(shopifyRefund.is_test);
  const secKey = isTest ? parsedKeys.test_sk : parsedKeys.sk;
  const refundApi = `${isTest ? config.cc.testApiUrl : config.cc.apiUrl}/cc/gpx/refunds`;
  const refundReqData = {
    amount: shopifyRefund.amount,
    ref: gpTx.flwRef,
    seckey: secKey,
  };
  const refundHmac = utils.generateCCRefundHmac(gpTx.AccountId, gpTx.flwRef, config.cc.secret);
  let axiosRes;

  try {
    axiosRes = await axios.post(refundApi, refundReqData, {
      headers: { 'x-shopify-app-hmac': refundHmac },
    });
  } catch (error) {
    const response = error.response;
    const resData = response?.data;
    await db
      .update({
        meta: utils.generateRefundMeta(shopifyRefund, {
          ...meta,
          refundApiReqSuccessful: false,
          lastApiResponseStatus: response.status,
          lastApiResponseObj: resData,
        }),
        retry_ts: shopifyRefund.retry_ts
          ? shopifyRefund.retry_ts + FIVE_MINUTES_MS
          : Date.now() + FIVE_MINUTES_MS,
      })
      .table(tables.shopifyRefund)
      .where({ id: shopifyRefund.id });
  }

  const axiosResData = axiosRes?.data;
  if (axiosRes && axiosResData?.status === 'success') {
    await resolveRefund(gid, {
      meta: utils.generateRefundMeta(shopifyRefund, {
        ...meta,
        refundApiReqSuccessful: true,
        lastApiResponseStatus: axiosRes.status,
        lastApiResponseObj: axiosResData,
      }),
    });
  }
};

exports.clearshopifyRefunds = async () => {
  const [shopifyRefund] = await db
    .select('*')
    .from(tables.shopifyRefund)
    .whereRaw(`status = "pending" AND retry_ts IS NOT NULL AND retry_ts <= ${Date.now()}`)
    .orderBy('retry_ts', 'asc')
    .limit(1);

  if (!shopifyRefund) return;

  let guarded = false;

  try {
    await db
      .insert({
        entity: `${shopifyRefund.refund_id}-${shopifyRefund.retry_ts}`,
        entity_type: 'SHRFD',
        createdAt: db.raw('CURRENT_TIMESTAMP'),
        updatedAt: db.raw('CURRENT_TIMESTAMP'),
      })
      .into(tables.progressGuard);
  } catch (error) {
    guarded = true;
  }

  if (guarded) return;

  const gid = shopifyRefund.gid;
  logger.info(`reattempting refund for ${gid}`);

  const [[shopConfig]] = await Promise.all([
    db.select('*').from(tables.shopifyConfig).where({ shop: shopifyOrder.shop }),
  ]);


  const keys = shopConfig && shopConfig.keys;
  const decryptedKeys = keys ? await utils.decrypt(keys, config.encryptionKey) : null;
  const parsedKeys = (decryptedKeys && JSON.parse(decryptedKeys)) || {};

  const secKey = Boolean(shopifyRefund.is_test) ? parsedKeys.test_sk : parsedKeys.sk;
  const baseUrl = Boolean(shopifyRefund.is_test) ? config.f4b.testApiUrl : config.f4b.apiUrl;

  let gpTx;

  
  try {
    const verifyTrx = await axios.get(`${baseUrl}/v3/transactions/${shopifyRefund.payment_id}/verify`, {
      headers: { Authorization: `Bearer ${secKey}` },
    });
    gpTx = verifyTrx.data.data || {};
  } catch (error) {
    gpTx = {};
    const loggable = new utils.LoggableAxiosError(error, {
      message: 'Transaction verification failed',
      tx_ref: shopifyRefund.payment_id,
    });
    logger.error(loggable);
  }
  const token = await utils.decrypt(shopConfig.access_token, config.encryptionKey);
  const client = utils.getGqlClient(shopifyRefund.shop, token);

  const rejectRefund = async (id, message, opts = {}) => {
    const mutation = gql`
      mutation RefundSessionReject($id: ID!, $reason: RefundSessionRejectionReasonInput!) {
        refundSessionReject(id: $id, reason: $reason) {
          refundSession {
            id
            status {
              code
              reason {
                ... on RefundSessionStatusReason {
                  code
                  merchantMessage
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      id,
      reason: {
        code: 'PROCESSING_ERROR',
        merchantMessage: message,
      },
    };

    let res = null;
    try {
      res = await client.request(mutation, variables);
    } catch (error) {
      // TODO: log this
    }

    const updateObj = { status: 'rejected' };
    if (opts.meta) updateObj.meta = opts.meta;

    await db.update(updateObj).table(tables.shopifyRefund).where({ id: shopifyRefund.id });
    return res;
  };

  const resolveRefund = async (id, opts = {}) => {
    const mutation = gql`
      mutation RefundSessionResolve($id: ID!) {
        refundSessionResolve(id: $id) {
          refundSession {
            id
            status {
              code
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    let res = null;
    try {
      res = await client.request(mutation, { id });
    } catch (error) {
      // TODO: log this
    }

    const updateObj = { status: 'resolved' };
    if (opts.meta) updateObj.meta = opts.meta;

    await db.update(updateObj).table(tables.shopifyRefund).where({ id: shopifyRefund.id });

    return res;
  };

  const meta = JSON.parse(shopifyRefund.meta);

  if (!meta) {
    // very very rare, but if happens, mark "invalid"
    return db.update({ status: null }).table(tables.shopifyRefund).where({ id: shopifyRefund.id });
  }

  if (meta.retryCount === meta.maxRetries) {
    await rejectRefund(gid, 'Unable to process refund', {
      meta: JSON.stringify(meta),
    });
  } else {
    meta.retryCount++;
  }

  if (meta.refundApiReqSuccessful) {
    return await resolveRefund(gid, {
      meta: utils.generateRefundMeta({
        ...meta,
      }),
    });
  }

  const isTest = Boolean(shopifyRefund.is_test);

  const refundApi = `${isTest ? config.cc.testApiUrl : config.cc.apiUrl}/cc/gpx/refunds`;
  const refundReqData = {
    amount: shopifyRefund.amount,
    ref: gpTx.flw_ref,
    seckey: secKey,
  };
  const refundHmac = utils.generateCCRefundHmac(gpTx.account_id, gpTx.flw_ref, config.cc.secret);
  let axiosRes;

  try {
    axiosRes = await axios.post(refundApi, refundReqData, {
      headers: { 'x-shopify-app-hmac': refundHmac },
    });
  } catch (error) {
    const response = error.response;
    const resData = response?.data;
    await db
      .update({
        meta: utils.generateRefundMeta(shopifyRefund, {
          ...meta,
          refundApiReqSuccessful: false,
          lastApiResponseStatus: response.status,
          lastApiResponseObj: resData,
        }),
        retry_ts: shopifyRefund.retry_ts
          ? shopifyRefund.retry_ts + FIVE_MINUTES_MS
          : Date.now() + FIVE_MINUTES_MS,
      })
      .table(tables.shopifyRefund)
      .where({ id: shopifyRefund.id });
  }

  const axiosResData = axiosRes?.data;
  if (axiosRes && axiosResData?.status === 'success') {
    await resolveRefund(gid, {
      meta: utils.generateRefundMeta(shopifyRefund, {
        ...meta,
        refundApiReqSuccessful: true,
        lastApiResponseStatus: axiosRes.status,
        lastApiResponseObj: axiosResData,
      }),
    });
  }
};
