const {
  config: { db },
} = require('../../config');

module.exports = {
  client: 'mysql2',
  connection: {
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  },
  pool: db.pool,
  migrations: { tableName: 'knex_migrations' },
};
