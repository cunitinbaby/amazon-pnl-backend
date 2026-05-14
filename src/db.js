// ─── Base de datos JSON simple ───────────────────────────────────────────────
// Guarda todo en un archivo JSON. Sin dependencias nativas (Railway-friendly).

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'pnl.json');

// Aseguramos que existe el directorio
fs.mkdirSync(DATA_DIR, { recursive: true });

// Estructura por defecto
const DEFAULT_DATA = {
  products: [],
  monthly_sales: {},   // { "productId__2026-04": {...} }
  monthly_ads:   {},   // { "productId__2026-04": {...} }
  fixed_costs:   [],
  sync_log:      [],
};

// Cargar datos
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[DB] Error cargando, usando default:', err.message);
  }
  return { ...DEFAULT_DATA };
}

// Guardar datos
function save(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[DB] Error guardando:', err.message);
  }
}

let _data = load();

// ─── Productos ────────────────────────────────────────────────────────────────
function getProducts() {
  return [..._data.products].sort((a, b) => a.name.localeCompare(b.name));
}

function upsertProduct(p) {
  const idx = _data.products.findIndex(x => x.asin === p.asin);
  if (idx >= 0) _data.products[idx] = { ..._data.products[idx], ...p };
  else          _data.products.push({ created_at: new Date().toISOString(), ...p });
  save(_data);
}

function deleteProduct(id) {
  _data.products = _data.products.filter(p => p.id !== id);
  save(_data);
}

// ─── Ventas mensuales ─────────────────────────────────────────────────────────
function _salesKey(pid, month) { return `${pid}__${month}`; }

function getMonthlySales(productId, month) {
  return _data.monthly_sales[_salesKey(productId, month)] || null;
}

function upsertMonthlySales(d) {
  _data.monthly_sales[_salesKey(d.product_id, d.month)] = d;
  save(_data);
}

// ─── Datos Ads ────────────────────────────────────────────────────────────────
function getMonthlyAds(productId, month) {
  return _data.monthly_ads[_salesKey(productId, month)] || null;
}

function upsertMonthlyAds(d) {
  _data.monthly_ads[_salesKey(d.product_id, d.month)] = d;
  save(_data);
}

// ─── Gastos fijos ─────────────────────────────────────────────────────────────
function getFixedCosts() {
  return _data.fixed_costs.filter(c => c.active !== false).sort((a, b) => a.name.localeCompare(b.name));
}

function upsertFixedCost(c) {
  const idx = _data.fixed_costs.findIndex(x => x.id === c.id);
  if (idx >= 0) _data.fixed_costs[idx] = { ..._data.fixed_costs[idx], ...c };
  else          _data.fixed_costs.push({ active: true, ...c });
  save(_data);
}

function deleteFixedCost(id) {
  const cost = _data.fixed_costs.find(c => c.id === id);
  if (cost) cost.active = false;
  save(_data);
}

// ─── Meses disponibles ────────────────────────────────────────────────────────
function getAvailableMonths() {
  const months = new Set();
  Object.keys(_data.monthly_sales).forEach(k => months.add(k.split('__')[1]));
  Object.keys(_data.monthly_ads).forEach(k   => months.add(k.split('__')[1]));
  return [...months].sort().reverse();
}

// ─── Datos completos de un mes ────────────────────────────────────────────────
function getMonthData(month) {
  const products = getProducts();
  const result   = {};

  for (const p of products) {
    const sales = getMonthlySales(p.id, month) || {};
    const ads   = getMonthlyAds(p.id, month)   || {};

    result[p.id] = {
      product:        p,
      units_ads:      ads.units_ads      || 0,
      units_organic:  sales.units_organic || 0,
      units_returned: sales.units_returned || 0,
      ppc_spend:      ads.ppc_spend      || 0,
      storage_fee:    sales.storage_fee   || 0,
      impressions:    ads.impressions    || 0,
      clicks:         ads.clicks         || 0,
    };
  }

  return result;
}

// ─── Sync log ─────────────────────────────────────────────────────────────────
function logSync(type, status, message, records = 0) {
  _data.sync_log.unshift({
    type, status, message, records,
    started_at: new Date().toISOString(),
  });
  // Mantener solo los últimos 100 logs
  _data.sync_log = _data.sync_log.slice(0, 100);
  save(_data);
}

function getLastSync(type) {
  return _data.sync_log.find(l => l.type === type) || null;
}

module.exports = {
  getProducts, upsertProduct, deleteProduct,
  getMonthlySales, upsertMonthlySales,
  getMonthlyAds, upsertMonthlyAds,
  getFixedCosts, upsertFixedCost, deleteFixedCost,
  getAvailableMonths, getMonthData,
  logSync, getLastSync,
};
