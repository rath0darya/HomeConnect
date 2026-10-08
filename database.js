const mysql = require("mysql2/promise");

let pool = null;

function mysqlConfig() {
  const url = process.env.MYSQL_URL;
  if (url) {
    const parsed = new URL(url);
    const config = {
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0
    };
    if (process.env.MYSQL_SSL === "true") {
      config.ssl = { rejectUnauthorized: process.env.MYSQL_SSL_REJECT_UNAUTHORIZED !== "false" };
    }
    return config;
  }

  const config = {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "homeconnect",
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  };

  if (process.env.MYSQL_SSL === "true") {
    config.ssl = { rejectUnauthorized: process.env.MYSQL_SSL_REJECT_UNAUTHORIZED !== "false" };
  }
  return config;
}

async function initDatabase() {
  if (pool) return pool;
  pool = mysql.createPool(mysqlConfig());

  await pool.query(`
    CREATE TABLE IF NOT EXISTS homeconnect_presence (
      role VARCHAR(16) NOT NULL PRIMARY KEY,
      online TINYINT(1) NOT NULL DEFAULT 0,
      registered_at DATETIME(3) NULL,
      last_seen DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    INSERT INTO homeconnect_presence (role, online, last_seen, updated_at)
    VALUES ('admin', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
           ('family', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE role = VALUES(role)
  `);

  await pool.query("UPDATE homeconnect_presence SET online = 0, updated_at = UTC_TIMESTAMP(3)");
  return pool;
}

async function setPresence(role, online) {
  if (!pool) return;
  await pool.query(
    `UPDATE homeconnect_presence
     SET online = ?, registered_at = CASE WHEN ? = 1 THEN UTC_TIMESTAMP(3) ELSE registered_at END,
         last_seen = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
     WHERE role = ?`,
    [online ? 1 : 0, online ? 1 : 0, role]
  );
}

async function touchPresence(role) {
  if (!pool) return;
  await pool.query(
    "UPDATE homeconnect_presence SET last_seen = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3) WHERE role = ? AND online = 1",
    [role]
  );
}

async function getPresence() {
  if (!pool) return { admin: false, family: false };
  const [rows] = await pool.query(
    "SELECT role, online FROM homeconnect_presence WHERE role IN ('admin','family')"
  );
  const result = { admin: false, family: false };
  for (const row of rows) result[row.role] = Boolean(row.online);
  return result;
}

async function closeDatabase() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

module.exports = { initDatabase, setPresence, touchPresence, getPresence, closeDatabase };
