// ─── Base de datos SQLite ─────────────────────────────────────────────────────
// Guarda todos los datos localmente en un archivo .db
// No necesita servidor externo, funciona en cualquier PC/Mac.

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'pnl.db');

// Aseguramos que existe el directorio
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Activar WAL mode para mejor rendimiento
db.pragma('journal_mode = WAL');

// ─── Crear tablas si no existen ───────────────────────────────────────────────
db.exec(`
  -- Productos (ASINs)
  CREATE TABLE IF NOT EXISTS products (
    id        TEXT PRIMARY KEY,
    asin      TEXT UNIQUE NOT NULL,
    name      TEXT NOT NULL,
    price     REAL DEFAULT 0,
    fees      REAL DEFAULT 0,
    cogs      REAL DEFAULT 0,
    color     TEXT DEFAULT '#FFB300',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Datos mensuales por producto (ventas orgánicas + devueltas)
  CREATE TABLE IF NOT EXISTS monthly_sales (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    TEXT NOT NULL,
    month         TEXT NOT NULL,  -- "2026-04"
    units_organic INTEGER DEFAULT 0,
    units_returned INTEGER DEFAULT 0,
    revenue       REAL DEFAULT 0,
    storage_fee   REAL DEFAULT 0,
    UNIQUE(product_id, month),
    FOREIGN KEY(product_id) REFERENCES products(id)
  );

  -- Datos de Sponsored Products (ads) - importado de CSV de Seller Central
  CREATE TABLE IF NOT EXISTS monthly_ads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  TEXT NOT NULL,
    month       TEXT NOT NULL,  -- "2026-04"
    units_ads   INTEGER DEFAULT 0,
    ppc_spend   REAL DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    clicks      INTEGER DEFAULT 0,
    UNIQUE(product_id, month),
    FOREIGN KEY(product_id) REFERENCES products(id)
  );

  -- Gastos fijos mensuales
  CREATE TABLE IF NOT EXISTS fixed_costs (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    amount    REAL NOT NULL,
    category  TEXT DEFAULT 'otro',
    active    INTEGER DEFAULT 1
  );

  -- Log de sincronizaciones
  CREATE TABLE IF NOT EXISTS sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    status     TEXT NOT NULL,
    message    TEXT,
    records    INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at   TEXT
  );
`);

// ─── Productos ────────────────────────────────────────────────────────────────
const getProducts = () =>
  db.prepare('SELECT * FROM products ORDER BY name').all();

const upsertProduct = (p) =>
  db.prepare(`
    INSERT INTO products (id, asin, name, price, fees, cogs, color)
    VALUES (@id, @asin, @name, @price, @fees, @cogs, @color)
    ON CONFLICT(asin) DO UPDATE SET
      name=excluded.name, price=excluded.price,
      fees=excluded.fees, cogs=excluded.cogs, color=excluded.color
  `).run(p);

const deleteProduct = (id) =>
  db.prepare('DELETE FROM products WHERE id=?').run(id);

// ─── Ventas mensuales ─────────────────────────────────────────────────────────
const getMonthlySales = (productId, month) =>
  db.prepare('SELECT * FROM monthly_sales WHERE product_id=? AND month=?').get(productId, month);

const getAllMonthlySales = (month) =>
  db.prepare('SELECT * FROM monthly_sales WHERE month=?').all(month);

const upsertMonthlySales = (data) =>
  db.prepare(`
    INSERT INTO monthly_sales (product_id, month, units_organic, units_returned, revenue, storage_fee)
    VALUES (@product_id, @month, @units_organic, @units_returned, @revenue, @storage_fee)
    ON CONFLICT(product_id, month) DO UPDATE SET
      units_organic=excluded.units_organic,
      units_returned=excluded.units_returned,
      revenue=excluded.revenue,
      storage_fee=excluded.storage_fee
  `).run(data);

// ─── Datos Ads ────────────────────────────────────────────────────────────────
const getMonthlyAds = (productId, month) =>
  db.prepare('SELECT * FROM monthly_ads WHERE product_id=? AND month=?').get(productId, month);

const getAllMonthlyAds = (month) =>
  db.prepare('SELECT * FROM monthly_ads WHERE month=?').all(month);

const upsertMonthlyAds = (data) =>
  db.prepare(`
    INSERT INTO monthly_ads (product_id, month, units_ads, ppc_spend, impressions, clicks)
    VALUES (@product_id, @month, @units_ads, @ppc_spend, @impressions, @clicks)
    ON CONFLICT(product_id, month) DO UPDATE SET
      units_ads=excluded.units_ads,
      ppc_spend=excluded.ppc_spend,
      impressions=excluded.impressions,
      clicks=excluded.clicks
  `).run(data);

// ─── Gastos fijos ─────────────────────────────────────────────────────────────
const getFixedCosts = () =>
  db.prepare('SELECT * FROM fixed_costs WHERE active=1 ORDER BY name').all();

const upsertFixedCost = (c) =>
  db.prepare(`
    INSERT INTO fixed_costs (id, name, amount, category)
    VALUES (@id, @name, @amount, @category)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, amount=excluded.amount, category=excluded.category
  `).run(c);

const deleteFixedCost = (id) =>
  db.prepare('UPDATE fixed_costs SET active=0 WHERE id=?').run(id);

// ─── Meses disponibles ────────────────────────────────────────────────────────
const getAvailableMonths = () => {
  const rows = db.prepare(`
    SELECT DISTINCT month FROM monthly_sales
    UNION
    SELECT DISTINCT month FROM monthly_ads
    ORDER BY month DESC
  `).all();
  return rows.map(r => r.month);
};

// ─── Datos completos de un mes ────────────────────────────────────────────────
const getMonthData = (month) => {
  const products = getProducts();
  const result   = {};

  for (const p of products) {
    const sales = getMonthlySales(p.id, month) || {};
    const ads   = getMonthlyAds(p.id, month)   || {};

    result[p.id] = {
      product:        p,
      units_ads:      ads.units_ads    || 0,
      units_organic:  sales.units_organic || 0,
      units_returned: sales.units_returned || 0,
      ppc_spend:      ads.ppc_spend    || 0,
      storage_fee:    sales.storage_fee || 0,
      impressions:    ads.impressions  || 0,
      clicks:         ads.clicks       || 0,
    };
  }

  return result;
};

// ─── Sync log ─────────────────────────────────────────────────────────────────
const logSync = (type, status, message, records = 0) =>
  db.prepare(`
    INSERT INTO sync_log (type, status, message, records)
    VALUES (?, ?, ?, ?)
  `).run(type, status, message, records);

const getLastSync = (type) =>
  db.prepare('SELECT * FROM sync_log WHERE type=? ORDER BY started_at DESC LIMIT 1').get(type);

module.exports = {
  db,
  getProducts, upsertProduct, deleteProduct,
  getMonthlySales, getAllMonthlySales, upsertMonthlySales,
  getMonthlyAds, getAllMonthlyAds, upsertMonthlyAds,
  getFixedCosts, upsertFixedCost, deleteFixedCost,
  getAvailableMonths, getMonthData,
  logSync, getLastSync,
};
