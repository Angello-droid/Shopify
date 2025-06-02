const { default: axios } = require('axios');
const crypto = require('crypto');
const { gql } = require('graphql-request');

const { config } = require('../config');
const { db, tables } = require('./db');
const { Shopify } = require('./shopify');
const utils = require('./utils');
const { logger } = require('../logger');
const FIVE_MINUTES_MS = 300000;

exports.handleAppHome = (nextHandler) => async (req, res) => {
  const { shop, hmac } = req.query;

  if (!shop || !utils.isValidShop(shop)) {
    return res.redirect('https://flutterwave.com');
  }

  const [savedShop] = await db
    .select(['id', 'is_installed'])
    .from(tables.shopifyConfig)
    .where({ shop });

  if (!hmac || !savedShop || !Boolean(savedShop.is_installed)) {
    res.redirect(`/auth?shop=${shop}`);
  } else {
    nextHandler(req, res);
  }
};

exports.handleAuthInit = async (req, res) => {
  const { shop } = req.query;

  if (!utils.isValidShop(shop)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid shop parameter provided.',
      data: null,
    });
  }

  const authRoute = await Shopify.Auth.beginAuth(req, res, shop, '/auth/callback', false);

  res.redirect(authRoute);
};

exports.handleAuthCallback = async (req, res) => {
  const shopSession = await Shopify.Auth.validateAuthCallback(req, res, req.query);
  const encryptedToken = await utils.encrypt(shopSession.accessToken, config.encryptionKey);

  await db
    .insert({ shop: shopSession.shop, access_token: encryptedToken, is_installed: 1 })
    .into(tables.shopifyConfig)
    .onConflict('shop')
    .merge();

  await Shopify.Webhooks.Registry.register({
    path: '/api/webhooks',
    topic: 'APP_UNINSTALLED',
    accessToken: shopSession.accessToken,
    shop: shopSession.shop,
  });

  res.redirect(`${config.appBaseURL}?shop=${shopSession.shop}&hmac=${req.query.hmac}`);
};

exports.handlePaymentInit = async (req, res) => {
  const shop = req.headers['shopify-shop-domain'];
  const order = req.body;

  const [[shopData], [existingOrder]] = await Promise.all([
    db.select('keys').from(tables.shopifyConfig).where({ shop }),
    db
      .select(['order_id', 'hosted_link', 'status'])
      .from(tables.shopifyOrder)
      .where({ shop, order_id: order.id }),
  ]);

  if (existingOrder && existingOrder.status === 'pending' && existingOrder.hosted_link) {
    return res.json({ redirect_url: existingOrder.hosted_link });
  }

  if (existingOrder && existingOrder.status === 'completed') {
    return res.status(400).json({
      success: false,
      message: 'order already completed',
    });
  }

  const isTest = Boolean(order.test);
  const keys = shopData && shopData.keys;
  const decryptedKeys = keys ? await utils.decrypt(keys, config.encryptionKey) : null;
  const parsedKeys = (decryptedKeys && JSON.parse(decryptedKeys)) || {};

  const paymentUrl = `${isTest ? config.f4b.testApiUrl : config.f4b.apiUrl}/v3/payments`;
  const paymentData = {
    tx_ref: order.id,
    amount: order.amount,
    currency: order.currency,
    redirect_url: `${config.appBaseURL}/api/payment/${shop}/redirect`,
    meta: { integration: 'shopify', shopify_shop: shop },
    customer: {
      email: order.customer.email || `shopify_${order.customer.phone_number}@flw.email`,
      phonenumber: order.customer.phone_number,
      name: `${order.customer?.billing_address?.given_name || 'FNAME'} ${
        order.customer?.billing_address?.family_name || 'LNAME'
      }`,
    },
  };
  const secKey = isTest ? parsedKeys.test_sk : parsedKeys.sk;

  let axiosRes;

  try {
    axiosRes = await axios.post(paymentUrl, paymentData, {
      headers: { Authorization: `Bearer ${secKey}` },
    });
  } catch (error) {
    const loggable = new utils.LoggableAxiosError(error, {
      message: 'hosted link generation failed',
      tx_ref: paymentData.tx_ref,
      currency: paymentData.currency,
    });

    logger.error(loggable);
  }

  const checkoutLink = axiosRes?.data?.data?.link || null;

  if (!checkoutLink) {
    return res.status(503).json({
      success: false,
      message: 'An error occured initiating the payment session.',
    });
  }

  await db
    .insert({
      order_id: order.id,
      gid: order.gid,
      shop,
      raw: JSON.stringify(order),
      is_test: Boolean(order.test),
      hosted_link: checkoutLink,
    })
    .into(tables.shopifyOrder);

  res.json({ redirect_url: checkoutLink });
};

//Edited by Joe
exports.handlePaymentRedirect = async (req, res) => {
  const shop = req.params.shop;
  const orderId = req.query.tx_ref;

  const statusMap = {
    completed: 'completed',
    successful: 'completed',
    canceled: 'cancelled',
    cancelled: 'cancelled',
    invalid: 'cancelled',
    failed: 'failed',
    pending: 'pending',
    success: 'completed',
    'success-pending-validation': 'pending',
  };

  let paymentStatus = statusMap[req.query.status];
  const gpTxId = (req.query.transaction_id && Number(req.query.transaction_id)) || null;

  let gpTxWhere =
    paymentStatus !== 'cancelled'
      ? `${gpTxId}/verify`
      : `verify_by_reference?tx_ref=${orderId}`;

  const [[existingOrder], [savedShop]] = await Promise.all([
    db.select(['id', 'gid', 'raw', 'is_test']).from(tables.shopifyOrder).where({ shop, order_id: orderId }),
    db.select(['id', 'access_token', 'keys']).from(tables.shopifyConfig).where({ shop }),
  ]);

  const orderResponse = JSON.parse(existingOrder.raw);

  const gptxPendStatuses = { pending: 1, 'success-pending-validation': 1 };
  const gptxSucessStatuses = { successful: 1, completed: 1 };
  const gptxFailedStatuses = { failed: 1 };

  
  const keys = savedShop && savedShop.keys;
  const decryptedKeys = keys ? await utils.decrypt(keys, config.encryptionKey) : null;
  const parsedKeys = (decryptedKeys && JSON.parse(decryptedKeys)) || {};

  const secKey = Boolean(existingOrder.is_test) ? parsedKeys.test_sk : parsedKeys.sk;
  const baseUrl = Boolean(existingOrder.is_test) ? config.f4b.testApiUrl : config.f4b.apiUrl;

  let gptx;
  if(paymentStatus !== "cancelled"){
    try {
      const verifyTrx = await axios.get(`${baseUrl}/v3/transactions/${gpTxWhere}`, {
        headers: { Authorization: `Bearer ${secKey}` },
      });
      if(verifyTrx)
      gptx = verifyTrx.data.data || {};
    } catch (error) {
      gptx = {};
      const loggable = new utils.LoggableAxiosError(error, {
        message: `Transaction verification failed:  ${req.query.transaction_id}`,
        tx_ref: orderId,
      });
      logger.error(loggable);
    }
  }else{
    gptx = {
      status: "cancelled"
    }
  }


  let gpOrder;

  if (!gptx) {
    const [order] = await db
      .select('id')
      .from(tables.getpaidOrder)
      .where({ txRef: orderId })
      .orderBy('id', 'desc')
      .limit(1);

    gpOrder = order;
  }

  if ((!gptx && gpOrder) || (gptx && gptxPendStatuses[gptx.status])) {
    paymentStatus = statusMap.pending;
  } else if (gptx && gptxSucessStatuses[gptx.status]) {
    paymentStatus = statusMap.completed;
  } else if (gptx && gptxFailedStatuses[gptx.status]) {
    paymentStatus = statusMap.failed;
  } else {
    paymentStatus = statusMap.cancelled;
  }

  if (paymentStatus !== 'cancelled') {
    const isValidTx =
      gptx &&
      utils.isValidCurrency(gptx.currency, orderResponse.currency) &&
      utils.isValidAmount(gptx.amount, orderResponse.amount);

    // verify currency/amount if already on gptx
    if (gptx && !isValidTx) {
      paymentStatus = statusMap.failed;
    }
  }

  await db
    .update({
      status: paymentStatus,
      gptxid: gptx?.id || null,
      account_id: gptx?.account_id || null,
    })
    .table(tables.shopifyOrder)
    .where({ shop, order_id: orderId });

  if (paymentStatus === 'cancelled') {
    const cancelUrl = orderResponse.cancel_url;

    return res.redirect(cancelUrl);
  }

  const token = await utils.decrypt(savedShop.access_token, config.encryptionKey);
  const client = utils.getGqlClient(shop, token);

  let nextAction;

  if (paymentStatus === 'completed') {
    const resolveMutation = gql`
      mutation PaymentSessionResolve($id: ID!) {
        paymentSessionResolve(id: $id) {
          paymentSession {
            id
            state {
              ... on PaymentSessionStateResolved {
                code
              }
            }
            nextAction {
              action
              context {
                ... on PaymentSessionActionsRedirect {
                  redirectUrl
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
    const resolveVariables = { id: existingOrder.gid };
    const rss = await client.request(resolveMutation, resolveVariables);
    nextAction = rss.paymentSessionResolve.paymentSession.nextAction;
  }

  if (paymentStatus === 'pending') {
    const pendMutation = gql`
      mutation PaymentSessionPending(
        $id: ID!
        $pendingExpiresAt: DateTime!
        $reason: PaymentSessionStatePendingReason!
      ) {
        paymentSessionPending(id: $id, pendingExpiresAt: $pendingExpiresAt, reason: $reason) {
          paymentSession {
            id
            state {
              ... on PaymentSessionStatePending {
                reason
              }
            }
            nextAction {
              action
              context {
                ... on PaymentSessionActionsRedirect {
                  redirectUrl
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

    const ms36Hours = 129600000; // 36H in milliseconds
    const pendExpiration = new Date(Date.now() + ms36Hours).toISOString(); // YYYY-MM-DDTHH:MM:SS.xxxZ
    const pendVariables = {
      id: existingOrder.gid,
      pendingExpiresAt: pendExpiration,
      reason: 'BUYER_ACTION_REQUIRED',
    };

    const rss = await client.request(pendMutation, pendVariables);
    nextAction = rss?.paymentSessionPending?.paymentSession?.nextAction;
  }

  if (paymentStatus === 'failed') {
    const rejectMutation = gql`
      mutation PaymentSessionReject($id: ID!, $reason: PaymentSessionRejectionReasonInput!) {
        paymentSessionReject(id: $id, reason: $reason) {
          paymentSession {
            id
            state {
              ... on PaymentSessionStateRejected {
                code
              }
            }
            nextAction {
              action
              context {
                ... on PaymentSessionActionsRedirect {
                  redirectUrl
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
    const rejectVariables = {
      id: existingOrder.gid,
      reason: {
        code: 'PROCESSING_ERROR', // or RISKY
        merchantMessage: gptx?.chargeResponseMessage || 'Payment failed',
      },
    };

    const rss = await client.request(rejectMutation, rejectVariables);
    nextAction = rss.paymentSessionReject.paymentSession.nextAction;
  }

  const redirectUrl = nextAction?.context?.redirectUrl || null;

  if (redirectUrl) {
    return res.redirect(redirectUrl);
  } else {
    res.end();
  }
};


exports.handlePaymentRedirectOriginal = async (req, res) => {
  const shop = req.params.shop;
  const orderId = req.query.tx_ref;

  const statusMap = {
    completed: 'completed',
    successful: 'completed',
    canceled: 'cancelled',
    cancelled: 'cancelled',
    invalid: 'cancelled',
    failed: 'failed',
    pending: 'pending',
    success: 'completed',
    'success-pending-validation': 'pending',
  };

  let paymentStatus = statusMap[req.query.status];
  const gpTxId = (req.query.transaction_id && Number(req.query.transaction_id)) || null;

  let gpTxWhere =
    paymentStatus !== 'cancelled'
      ? { id: gpTxId }
      : { txRef: orderId, status: 'success-pending-validation' };

  const [[existingOrder], [savedShop], [gptx]] = await Promise.all([
    db.select(['id', 'gid', 'raw']).from(tables.shopifyOrder).where({ shop, order_id: orderId }),
    db.select(['id', 'access_token']).from(tables.shopifyConfig).where({ shop }),
    db
      .select(['id', 'status', 'currency', 'amount', 'chargeResponseMessage', 'AccountId'])
      .from(tables.getpaidTransaction)
      .where(gpTxWhere)
      .orderBy('id', 'desc')
      .limit(1),
  ]);
  const orderResponse = JSON.parse(existingOrder.raw);

  const gptxPendStatuses = { pending: 1, 'success-pending-validation': 1 };
  const gptxSucessStatuses = { successful: 1, completed: 1 };
  const gptxFailedStatuses = { failed: 1 };

  let gpOrder;

  if (!gptx) {
    const [order] = await db
      .select('id')
      .from(tables.getpaidOrder)
      .where({ txRef: orderId })
      .orderBy('id', 'desc')
      .limit(1);

    gpOrder = order;
  }

  if ((!gptx && gpOrder) || (gptx && gptxPendStatuses[gptx.status])) {
    paymentStatus = statusMap.pending;
  } else if (gptx && gptxSucessStatuses[gptx.status]) {
    paymentStatus = statusMap.completed;
  } else if (gptx && gptxFailedStatuses[gptx.status]) {
    paymentStatus = statusMap.failed;
  } else {
    paymentStatus = statusMap.cancelled;
  }
  const isValidTx =
    gptx &&
    utils.isValidCurrency(gptx.currency, orderResponse.currency) &&
    utils.isValidAmount(gptx.amount, orderResponse.amount);

  // verify currency/amount if already on gptx
  if (gptx && !isValidTx) {
    paymentStatus = statusMap.failed;
  }

  await db
    .update({
      status: paymentStatus,
      gptxid: gptx?.id || null,
      account_id: gptx?.AccountId || null,
    })
    .table(tables.shopifyOrder)
    .where({ shop, order_id: orderId });

  if (paymentStatus === 'cancelled') {
    const cancelUrl = orderResponse.cancel_url;

    return res.redirect(cancelUrl);
  }

  const token = await utils.decrypt(savedShop.access_token, config.encryptionKey);
  const client = utils.getGqlClient(shop, token);

  let nextAction;

  if (paymentStatus === 'completed') {
    const resolveMutation = gql`
      mutation PaymentSessionResolve($id: ID!) {
        paymentSessionResolve(id: $id) {
          paymentSession {
            id
            status {
              code
            }
            nextAction {
              action
              context {
                ... on PaymentSessionActionsRedirect {
                  redirectUrl
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
    const resolveVariables = { id: existingOrder.gid };
    const rss = await client.request(resolveMutation, resolveVariables);
    nextAction = rss.paymentSessionResolve.paymentSession.nextAction;
  }

  if (paymentStatus === 'pending') {
    const pendMutation = gql`
      mutation PaymentSessionPending(
        $id: ID!
        $pendingExpiresAt: DateTime!
        $reason: PaymentSessionStatePendingReason!
      ) {
        paymentSessionPending(id: $id, pendingExpiresAt: $pendingExpiresAt, reason: $reason) {
          paymentSession {
            id
            state {
              ... on PaymentSessionStatePending {
                reason
              }
            }
            nextAction {
              action
              context {
                ... on PaymentSessionActionsRedirect {
                  redirectUrl
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

    const ms36Hours = 129600000; // 36H in milliseconds
    const pendExpiration = new Date(Date.now() + ms36Hours).toISOString(); // YYYY-MM-DDTHH:MM:SS.xxxZ
    const pendVariables = {
      id: existingOrder.gid,
      pendingExpiresAt: pendExpiration,
      reason: 'BUYER_ACTION_REQUIRED',
    };

    const rss = await client.request(pendMutation, pendVariables);
    nextAction = rss?.paymentSessionPending?.paymentSession?.nextAction;
  }

  if (paymentStatus === 'failed') {
    const rejectMutation = gql`
      mutation PaymentSessionReject($id: ID!, $reason: PaymentSessionRejectionReasonInput!) {
        paymentSessionReject(id: $id, reason: $reason) {
          paymentSession {
            id
            status {
              code
            }
            nextAction {
              action
              context {
                ... on PaymentSessionActionsRedirect {
                  redirectUrl
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
    const rejectVariables = {
      id: existingOrder.gid,
      reason: {
        code: 'PROCESSING_ERROR', // or RISKY
        merchantMessage: gptx?.chargeResponseMessage || 'Payment failed',
      },
    };

    const rss = await client.request(rejectMutation, rejectVariables);
    nextAction = rss.paymentSessionReject.paymentSession.nextAction;
  }

  const redirectUrl = nextAction?.context?.redirectUrl || null;

  if (redirectUrl) {
    return res.redirect(redirectUrl);
  } else {
    res.end();
  }
};

//Edited by Joe
exports.handleRefundInit = async (req, res) => {
  const { id, gid, payment_id, amount, currency, test: is_test } = req.body;
  const [shopifyOrder] = await db
    .select(['order_id', 'shop', 'is_test', 'status', 'gptxid', 'account_id'])
    .from(tables.shopifyOrder)
    .where({ order_id: payment_id });

  if (!shopifyOrder) {
    return res.status(400).json({
      success: false,
      message: 'No corresponding shopify order found for refund request',
    });
  }
  const defaultMeta = {
    refundApiReqSuccessful: null,
    retryCount: 0,
    maxRetries: 7,
    lastApiResponseStatus: null,
    lastApiResponseObj: null,
  };

  function generateRefundMeta(shopifyRefund = {}, meta = defaultMeta) {
    let savedMeta = {};
    try {
      savedMeta = JSON.parse(shopifyRefund.meta) || defaultMeta;
    } catch (e) {}
    const mergedMeta = { ...savedMeta, ...meta };
    return JSON.stringify(mergedMeta);
  }

  const shopifyRefund = await db.transaction(async (t) => {
    let data = null;
    try {
      await db
        .insert({
          refund_id: id,
          gid,
          payment_id,
          currency,
          amount,
          is_test: Boolean(is_test),
          shop: shopifyOrder.shop,
          account_id: shopifyOrder.account_id,
          gptxid: shopifyOrder.gptxid,
          meta: JSON.stringify(defaultMeta),
        })
        .into(tables.shopifyRefund)
        .transacting(t);

      const [inserted] = await db
        .select('*')
        .from(tables.shopifyRefund)
        .where({ refund_id: id })
        .transacting(t);

      data = inserted;
    } catch (e) {
      if (e && e.code !== 'ER_DUP_ENTRY') {
        throw e;
      }
    }

    return data;
  });
  if (!shopifyRefund) {
    //! this branch short circuits entire request! (see return)
    return res.status(201).json({
      success: true,
      message: 'Refund request already logged!',
    });
  } else {
    res.status(201).json({
      success: true,
      message: 'New refund request logged sucessfully',
    });
  }

  const [[shopConfig]] = await Promise.all([
    db.select('*').from(tables.shopifyConfig).where({ shop: shopifyOrder.shop }),
  ]);


  const keys = shopConfig && shopConfig.keys;
  const decryptedKeys = keys ? await utils.decrypt(keys, config.encryptionKey) : null;
  const parsedKeys = (decryptedKeys && JSON.parse(decryptedKeys)) || {};

  const secKey = Boolean(is_test) ? parsedKeys.test_sk : parsedKeys.sk;
  const baseUrl = Boolean(is_test) ? config.f4b.testApiUrl : config.f4b.apiUrl;

  let gpTx;
  try {
    const verifyTrx = await axios.get(`${baseUrl}/v3/transactions/${shopifyOrder.gptxid}/verify`, {
      headers: { Authorization: `Bearer ${secKey}` },
    });
    gpTx = verifyTrx.data.data || {};
  } catch (error) {
    gpTx = {};
    const loggable = new utils.LoggableAxiosError(error, {
      message: 'Transaction verification failed',
      tx_ref: shopifyOrder.order_id,
    });
    logger.error(loggable);
  }

  const token = await utils.decrypt(shopConfig.access_token, config.encryptionKey);
  const client = utils.getGqlClient(shopifyOrder.shop, token);

  const rejectRefund = async (id, message) => {
    const mutation = gql`
      mutation RefundSessionReject($id: ID!, $reason: RefundSessionRejectionReasonInput!) {
        refundSessionReject(id: $id, reason: $reason) {
          refundSession {
            id
            state {
              ... on RefundSessionStateRejected {
                code
              }
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

    await db.update({ status: 'rejected' }).table(tables.shopifyRefund).where({
      id: shopifyRefund.id,
    });
    return res;
  };

  const resolveRefund = async (id, opts = {}) => {
    const mutation = gql`
      mutation RefundSessionResolve($id: ID!) {
        refundSessionResolve(id: $id) {
          refundSession {
            id
            state {
              ... on RefundSessionStateResolved {
                code
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

  if (shopifyOrder.status !== 'completed') {
    return await rejectRefund(gid, 'Payment not completed');
  }

  if (Boolean(is_test) !== Boolean(shopifyOrder.is_test)) {
    return await rejectRefund(gid, "Can't refund orders made in different environments");
  }

  if (parseFloat(amount) > parseFloat(gpTx.amount)) {
    return await rejectRefund(gid, 'Refund amount greater than amount paid');
  }

  if (!parsedKeys.sk) {
    return rejectRefund(gid, 'Unable to process refund');
  }

  const refundApi = `${Boolean(is_test) ? config.cc.testApiUrl : config.cc.apiUrl}/cc/gpx/refunds`;
  const refundReqData = {
    amount,
    ref: gpTx.flw_ref,
    // callbackurl: 'callbackurl',
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
        meta: generateRefundMeta(shopifyRefund, {
          refundApiReqSuccessful: false,
          lastApiResponseStatus: response.status,
          lastApiResponseObj: resData,
        }),
        retry_ts: Date.now() + FIVE_MINUTES_MS,
      })
      .table(tables.shopifyRefund)
      .where({ id: shopifyRefund.id });
  }

  const axiosResData = axiosRes?.data;
  if (axiosRes && axiosResData?.status === 'success') {
    await resolveRefund(gid, {
      meta: generateRefundMeta(shopifyRefund, {
        refundApiReqSuccessful: true,
        lastApiResponseStatus: axiosRes.status,
        lastApiResponseObj: axiosResData,
      }),
    });
  }
};

exports.handleRefundInitOriginal = async (req, res) => {
  const { id, gid, payment_id, amount, currency, test: is_test } = req.body;
  const [shopifyOrder] = await db
    .select(['order_id', 'shop', 'is_test', 'status', 'gptxid', 'account_id'])
    .from(tables.shopifyOrder)
    .where({ order_id: payment_id });

  if (!shopifyOrder) {
    return res.status(400).json({
      success: false,
      message: 'No corresponding shopify order found for refund request',
    });
  }

  const defaultMeta = {
    refundApiReqSuccessful: null,
    retryCount: 0,
    maxRetries: 7,
    lastApiResponseStatus: null,
    lastApiResponseObj: null,
  };

  function generateRefundMeta(shopifyRefund = {}, meta = defaultMeta) {
    let savedMeta = {};
    try {
      savedMeta = JSON.parse(shopifyRefund.meta) || defaultMeta;
    } catch (e) {}
    const mergedMeta = { ...savedMeta, ...meta };
    return JSON.stringify(mergedMeta);
  }

  const shopifyRefund = await db.transaction(async (t) => {
    let data = null;
    try {
      await db
        .insert({
          refund_id: id,
          gid,
          payment_id,
          currency,
          amount,
          is_test: Boolean(is_test),
          shop: shopifyOrder.shop,
          account_id: shopifyOrder.account_id,
          gptxid: shopifyOrder.gptxid,
          meta: JSON.stringify(defaultMeta),
        })
        .into(tables.shopifyRefund)
        .transacting(t);

      const [inserted] = await db
        .select('*')
        .from(tables.shopifyRefund)
        .where({ refund_id: id })
        .transacting(t);

      data = inserted;
    } catch (e) {
      if (e && e.code !== 'ER_DUP_ENTRY') {
        throw e;
      }
    }

    return data;
  });

  if (!shopifyRefund) {
    //! this branch short circuits entire request! (see return)
    return res.status(201).json({
      success: true,
      message: 'Refund request already logged!',
    });
  } else {
    res.status(201).json({
      success: true,
      message: 'New refund request logged sucessfully',
    });
  }

  const [[shopConfig], [gpTx]] = await Promise.all([
    db.select('*').from(tables.shopifyConfig).where({ shop: shopifyOrder.shop }),
    db
      .select(['id', 'flwRef', 'amount', 'currency', 'AccountId'])
      .from(tables.getpaidTransaction)
      .where({ id: shopifyOrder.gptxid }),
  ]);

  const token = await utils.decrypt(shopConfig.access_token, config.encryptionKey);
  const client = utils.getGqlClient(shopifyOrder.shop, token);

  const rejectRefund = async (id, message) => {
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

    await db.update({ status: 'rejected' }).table(tables.shopifyRefund).where({
      id: shopifyRefund.id,
    });
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

  if (shopifyOrder.status !== 'completed') {
    return await rejectRefund(gid, 'Payment not completed');
  }

  if (Boolean(is_test) !== Boolean(shopifyOrder.is_test)) {
    return await rejectRefund(gid, "Can't refund orders made in different environments");
  }

  if (parseFloat(amount) > parseFloat(gpTx.amount)) {
    return await rejectRefund(gid, 'Refund amount greater than amount paid');
  }

  const keys = shopConfig && shopConfig.keys;
  const decryptedKeys = keys ? await utils.decrypt(keys, config.encryptionKey) : null;
  const parsedKeys = (decryptedKeys && JSON.parse(decryptedKeys)) || {};

  if (!parsedKeys.sk) {
    return rejectRefund(gid, 'Unable to process refund');
  }

  const secKey = Boolean(is_test) ? parsedKeys.test_sk : parsedKeys.sk;
  const refundApi = `${Boolean(is_test) ? config.cc.testApiUrl : config.cc.apiUrl}/cc/gpx/refunds`;
  const refundReqData = {
    amount,
    ref: gpTx.flwRef,
    // callbackurl: 'callbackurl',
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
        meta: generateRefundMeta(shopifyRefund, {
          refundApiReqSuccessful: false,
          lastApiResponseStatus: response.status,
          lastApiResponseObj: resData,
        }),
        retry_ts: Date.now() + FIVE_MINUTES_MS,
      })
      .table(tables.shopifyRefund)
      .where({ id: shopifyRefund.id });
  }

  const axiosResData = axiosRes?.data;
  if (axiosRes && axiosResData?.status === 'success') {
    await resolveRefund(gid, {
      meta: generateRefundMeta(shopifyRefund, {
        refundApiReqSuccessful: true,
        lastApiResponseStatus: axiosRes.status,
        lastApiResponseObj: axiosResData,
      }),
    });
  }
};

exports.handleUpdateSettings = async (req, res) => {
  const data = req.body;
  const shop = req.body.shop;

  if (!shop) {
    return res.status(400).json({
      success: false,
      message: 'shop is required!',
      data: null,
    });
  }

  const [savedShop] = await db
    .select(['id', 'access_token'])
    .from(tables.shopifyConfig)
    .where({ shop });

  if (!savedShop) {
    return res.status(400).json({
      success: false,
      message: 'shop not found!',
      data: null,
    });
  }

  const [validLiveSk, validTestSk, account] = await Promise.all([
    utils.validateSecretKey(data.sk),
    utils.validateSecretKey(data.test_sk),
    utils.getMerchantInfo(data.pk),
  ]);

  if (!(validLiveSk && validTestSk)) {
    return res.status(400).json({
      success: false,
      message: 'Unable to validate provided keys',
      data: null,
    });
  }

  const keys = JSON.stringify({
    sk: data.sk,
    pk: data.pk,
    test_sk: data.test_sk,
    test_pk: data.test_pk,
  });

  const encryptedKeys = await utils.encrypt(keys, config.encryptionKey);

  await db
    .update({ keys: encryptedKeys, account_id: account?.id || null })
    .table(tables.shopifyConfig)
    .where({ id: savedShop.id });

  const token = await utils.decrypt(savedShop.access_token, config.encryptionKey);
  const client = utils.getGqlClient(shop, token);

  const mutation = gql`
    mutation paymentsAppConfigure($ready: Boolean!, $externalHandle: String) {
      paymentsAppConfigure(ready: $ready, externalHandle: $externalHandle) {
        paymentsAppConfiguration {
          externalHandle
          ready
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const variables = {
    ready: true,
    externalHandle: account?.business_name || 'Flutterwave Merchant',
  };

  await client.request(mutation, variables);

  res.json({
    success: true,
    message: 'API keys updated successfully',
    redirect_url: `https://${shop}/services/payments_partners/gateways/${config.shopify.apiKey}/settings`,
  });
};

exports.handleFetchSettings = async (req, res) => {
  const shop = req.query.shop;

  if (!shop) {
    return res.status(400).json({
      success: false,
      message: 'shop is required',
      data: null,
    });
  }

  const [savedShop] = await db.select(['id', 'keys']).from(tables.shopifyConfig).where({ shop });

  if (!savedShop) {
    return res.status(404).json({
      success: false,
      message: 'shop not found',
      data: null,
    });
  }

  const decryptedKeys = savedShop.keys
    ? await utils.decrypt(savedShop.keys, config.encryptionKey)
    : null;
  const parsedKeys = (decryptedKeys && JSON.parse(decryptedKeys)) || {};
  const returnData = {
    prodSk: utils.maskKey(parsedKeys.sk) || '',
    prodPk: parsedKeys.pk || '',
    testSk: utils.maskKey(parsedKeys.test_sk) || '',
    testPk: parsedKeys.test_pk || '',
  };

  res.json({
    success: true,
    message: 'Configured keys retrieved',
    data: returnData,
  });
};

exports.handleWebhooks = async (req, res) => {
  try {
    await Shopify.Webhooks.Registry.process(req, res);
  } catch (error) {
    logger.error(error, 'error handling incoming shopify webhook');
  }
};

exports.handleGdprHooks = async (req, res) => {
  const { topic } = req.params;
  const { body } = req;
  const shop = req.body.shop_domain;
  const validTopics = { customers_data_request: 1, customers_data_redact: 1, shop_redact: 1 };

  if (!validTopics[topic]) {
    return res.status(400).json({
      success: false,
      message: 'Unable to process GDPR hook',
      data: null,
    });
  }

  let logged = false;

  try {
    await db
      .insert({
        shop,
        webhook_topic: topic,
        request_body: JSON.stringify(body),
      })
      .into(tables.shopifyGdprRequest);
    logged = true;
  } catch (error) {
    logger.error(error, 'error handling gdpr hook');
  }

  if (logged) {
    res.json({
      success: true,
      message: 'GDPR hook received',
      data: null,
    });
  } else {
    res.status(400).json({
      success: false,
      message: 'Unable to process GDPR hook',
      data: null,
    });
  }
};

exports.handlePaymentCallback = async (req, res) => {
  const hmac = req.headers['x-f4b-hmac'];
  if (!hmac) {
    return res.status(401).json({
      success: false,
      message: 'missing hmac',
      data: null,
    });
  }

  const { tx_id: gpTxId, tx_ref: orderId, account_id, shop, status } = req.body;

  const hmacData = `${shop}|${gpTxId}|${orderId}|${account_id}`;
  const generatedHmac = crypto
    .createHmac('sha256', config.f4b.secret)
    .update(hmacData)
    .digest('hex');

  if (hmac !== generatedHmac) {
    return res.status(401).json({
      success: false,
      message: 'hmac missmatch!',
      data: null,
    });
  }

  if (status === 'failed') {
    return res.end(); // prevent marking as failed on auto reroute
  }

  const [[existingOrder], [savedShop], [gptx]] = await Promise.all([
    db.select(['id', 'gid', 'status', 'raw']).from(tables.shopifyOrder).where({
      shop,
      order_id: orderId,
    }),
    db.select(['id', 'access_token']).from(tables.shopifyConfig).where({ shop }),
    db
      .select(['id', 'status', 'currency', 'amount', 'chargeResponseMessage', 'AccountId'])
      .from(tables.getpaidTransaction)
      .where({ id: Number(gpTxId) }),
  ]);
  const finalStatuses = { completed: 1, failed: 1 };

  if (!existingOrder) {
    const loggable = new utils.LoggableAxiosError(req, {
      message: 'Shopify Order Not Found',
      data: req.body,
      origin:  `${req.protocol}://${req.get('host')}`,
      ip: req.socket.remoteAddress,
      headers: req.headers
    });
    logger.error(loggable);

    return res.status(400).json({
      success: false,
      message: 'shopify order not found',
      data: null,
    });
  }

  if (finalStatuses[existingOrder.status]) {
    // order already finalized.
    return res.end();
  }

  let paymentStatus = gptx.status === 'successful' ? 'completed' : 'failed';
  const orderResponse = JSON.parse(existingOrder.raw);
  const isValidTx =
    gptx &&
    utils.isValidCurrency(gptx.currency, orderResponse.currency) &&
    utils.isValidAmount(gptx.amount, orderResponse.amount);

  if (!isValidTx) {
    paymentStatus = 'failed';
  }

  await db
    .update({ status: paymentStatus, gptxid: gpTxId, account_id: gptx?.AccountId || null })
    .table(tables.shopifyOrder)
    .where({ shop, order_id: orderId });

  const token = await utils.decrypt(savedShop.access_token, config.encryptionKey);

  const client = utils.getGqlClient(shop, token);
  const resolvePayment = async () => {
    const resolveMutation = gql`
      mutation PaymentSessionResolve($id: ID!) {
        paymentSessionResolve(id: $id) {
          paymentSession {
            id
            state {
              ... on PaymentSessionStateResolved {
                code
              }
            }
            nextAction {
              action
              context {
                ... on PaymentSessionActionsRedirect {
                  redirectUrl
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
    const resolveVariables = { id: existingOrder.gid };
    await client.request(resolveMutation, resolveVariables);
  };
  const rejectPayment = async () => {
    const rejectMutation = gql`
      mutation PaymentSessionReject($id: ID!, $reason: PaymentSessionRejectionReasonInput!) {
        paymentSessionReject(id: $id, reason: $reason) {
          paymentSession {
            id
            state {
              ... on PaymentSessionStateRejected {
                code
              }
            }
            nextAction {
              action
              context {
                ... on PaymentSessionActionsRedirect {
                  redirectUrl
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
    const rejectVariables = {
      id: existingOrder.gid,
      reason: {
        code: 'PROCESSING_ERROR',
        merchantMessage: gptx?.chargeResponseMessage || 'Payment failed',
      },
    };
    await client.request(rejectMutation, rejectVariables);
  };

  if (paymentStatus === 'completed') {
    setTimeout(resolvePayment, 5000);
  } else {
    setTimeout(rejectPayment, 5000);
  }

  res.json({
    success: true,
    message: 'Callback received!',
    data: null,
  });
};

const generateReqData = ({ tx_id, tx_ref, account_id, status, shop }) => {
  const hmacData = `${shop}|${tx_id}|${tx_ref}|${account_id}`;
  const data = { tx_id, tx_ref, account_id, status, shop };
  const hmac = crypto.createHmac('sha256', config.f4b.secret).update(hmacData).digest('hex');

  return { hmac, data };
};

const sendCb = (cbInfo) => {
  const API = `${config.appBaseURL}/api/payment/callback`;
  axios
    .post(API, cbInfo.data, { headers: { 'x-f4b-hmac': cbInfo.hmac } })
    .catch((error) =>
      logger.error(new utils.LoggableAxiosError(error, { message: 'payment/callback error' })),
    );
};

exports.handlePendingPaymentsBackfill = async (req, res) => {
  const { 'x-backfill-token': token } = req.headers;

  if (!token || !(config.backfillToken === token)) {
    return res.status(401).json({
      success: false,
      message: 'invalid token',
      data: null,
    });
  }

  const [txns] = await db.raw(
    `select t.id as tx_id, t.txRef as tx_ref, t.AccountId as account_id, t.status as status, so.shop as shop from shopify_order so join getpaid_transaction t on so.order_id = t.txRef where so.status <> 'completed' and t.status = 'successful' and so.is_test = 0 order by so.id asc`,
  );

  if (Array.isArray(txns) && txns.length) {
    txns.map(generateReqData).forEach(sendCb);
  }

  return res.json({
    success: true,
    message: 'backfill ran',
    data: { transaction_count: txns.length },
  });
};
