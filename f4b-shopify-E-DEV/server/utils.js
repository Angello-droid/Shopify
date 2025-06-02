const { AxiosError, default: axios } = require('axios');
const crypto = require('crypto');
const { GraphQLClient } = require('graphql-request');
const { config } = require('../config');
const { logger } = require('../logger');

function generateMD5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

exports.encrypt = function encrypt(text, key) {
  return new Promise((resolve, reject) => {
    try {
      // 256-cbc expects keylen of 32 bytes
      const keyMd5 = generateMD5(key);
      const iv = `${generateMD5(keyMd5)}-f4bcrypto==`;
      /**
       * Using buffer.from on the
       * generated md5 hash of the iv
       * returns a buffer with length: 16
       * which is the required iv size for
       * aes-256-cbc
       */
      const ivBuffer = Buffer.from(generateMD5(iv), 'hex');

      const ciphr = crypto.createCipheriv('aes-256-cbc', keyMd5, ivBuffer);
      const encryptedData = Buffer.concat([ciphr.update(text), ciphr.final()]).toString('hex');

      resolve(encryptedData);
    } catch (error) {
      reject(error);
    }
  });
};

exports.decrypt = function decrypt(encrypted, key) {
  return new Promise((resolve, reject) => {
    try {
      const keyMd5 = generateMD5(key);
      const iv = `${generateMD5(keyMd5)}-f4bcrypto==`;
      const ivBuffer = Buffer.from(generateMD5(iv), 'hex');

      const ciphr = crypto.createDecipheriv('aes-256-cbc', keyMd5, ivBuffer);
      const decryptedData = Buffer.concat([
        ciphr.update(Buffer.from(encrypted, 'hex')),
        ciphr.final(),
      ]).toString();

      resolve(decryptedData);
    } catch (error) {
      reject(error);
    }
  });
};

exports.maskKey = (key = '') => {
  if (!key) return null;

  const firstSeg = key.slice(0, 12);
  const lastSeg = key.slice(-6);

  return `${firstSeg}************${lastSeg}`;
};

exports.getGqlClient = (shop_url, accessToken) => {
  return new GraphQLClient(`https://${shop_url}/payments_apps/api/2023-10/graphql.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken },
  });
};

exports.isValidShop = (shop = '') => {
  const shopUrlRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.(com|io)[/]*$/;
  return shopUrlRegex.test(shop);
};

exports.generateCCRefundHmac = (accountId, flwRef, secret) => {
  return crypto.createHmac('sha256', secret).update(`${accountId}|${flwRef}`).digest('hex');
};

const defaultMeta = {
  refundApiReqSuccessful: null,
  retryCount: 0,
  maxRetries: 7,
  lastApiResponseStatus: null,
  lastApiResponseObj: null,
};

exports.generateRefundMeta = function generateRefundMeta(shopifyRefund = {}, meta = defaultMeta) {
  let savedMeta = {};
  try {
    savedMeta = JSON.parse(shopifyRefund.meta) || defaultMeta;
  } catch (e) {}
  const mergedMeta = { ...savedMeta, ...meta };
  return JSON.stringify(mergedMeta);
};

exports.handleAsyncErrors = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

exports.isValidCurrency = (c1 = '', c2 = '') => c1.trim().toUpperCase() === c2.trim().toUpperCase();
exports.isValidAmount = (gptxA, shpA) => parseFloat(gptxA) >= parseFloat(shpA);

exports.LoggableAxiosError = class LoggableAxiosError extends Error {
  /**
   * @typedef {object} Props
   * @property {string} [message]
   *
   * @param {AxiosError} error
   * @param {Props} props
   */
  constructor(error, props) {
    const msg = props.message || error.message || 'Axios Error';
    super(msg);

    this.ctx = {
      responseData: error?.response?.data,
      responseCode: error?.response?.status,
      errorCode: error?.code,
      ...props,
    };
  }
};

exports.validateSecretKey = async (key) => {
  const API = `${config.f4b.apiUrl}/v3/transfers/fee`;

  try {
    const res = await axios.get(API, {
      headers: { Authorization: `Bearer ${key}` },
      params: { currency: 'NGN', amount: 100 },
    });

    return res.status < 400;
  } catch (error) {
    logger.error(new exports.LoggableAxiosError(error, { message: 'secret key validation error' }));
    return false;
  }
};

exports.getMerchantInfo = async (pk) => {
  const API = `${config.f4b.apiUrl}/flwv3-pug/getpaidx/api/mercinfo`;

  try {
    const { data } = await axios.get(API, { params: { PBFPubKey: pk } });

    if (!data || !data.mn) {
      return null;
    }

    return {
      id: null, // TODO: when f4b exposes a v3 resource that returns account id, update & fill.
      business_name: data.mn,
    };
  } catch (error) {
    logger.error(new exports.LoggableAxiosError(error, { message: 'Unable to get merchant info' }));
    return null;
  }
};
