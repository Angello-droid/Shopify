const pino = require('pino');
const { config } = require('./config');

/**
 * @type import("pino").BaseLogger
 */
exports.logger = pino({
  formatters: {
    level: (label) => ({ level: label }),
  },
  level: config.logging.level,
});
