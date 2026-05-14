// ─── Base de datos JSON ──────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'pnl.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_DATA = {
  products: [], monthly_sales: {}, monthly_ads: {},
  fixed_costs: [], sync_log: [],
  last_sync_date: null,
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('[DB] Error cargando:', err.message);
  }
  return { ...DEFAULT_DATA };
}

function save(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.error('[DB] Error guardando:', err.message); }
}

let _data = load();
// Asegurar campo last_sync_date
if (!_data.last_sync_date) _data.last_sync_date = null;

const _k = (pid, m) => `${pid}__${m}`;

// ─── Productos ────────────────────────────────────────────────────────────────
const getProducts = () => [..._data.products].sort((a,b)=>a.name.localeCompare(b.name));

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
const getMonthlySales = (pid, m) => _data.monthly_sales[_k(pid, m)] || null;

function upsertMonthlySales(d) {
  _data.monthly_sales[_k(d.product_id, d.month)] = d;
  save(_data);
}

// ─── Ads ──────────────────────────────────────────────────────────────────────
const getMonthlyAds = (pid, m) => _data.monthly_ads[_k(pid, m)] || null;

function upsertMonthlyAds(d) {
  _data.monthly_ads[_k(d.product_id, d.month)] = d;
  save(_data);
}

// ─── Gastos fijos ─────────────────────────────────────────────────────────────
const getFixedCosts = () => _data.fixed_costs.filter(c => c.active !== false).sort((a,b)=>a.name.localeCompare(b.name));

function upsertFixedCost(c) {
  const idx = _data.fixed_costs.findIndex(x => x.id === c.id);
  if (idx >= 0) _data.fixed_costs[idx] = { ..._data.fixed_costs[idx], ...c };
  else          _data.fixed_costs.push({ active: true, ...c });
  save(_data);
}

function deleteFixedCost(id) {
  const c = _data.fixed_costs.find(c => c.id === id);
  if (c) c.active = false;
  save(_data);
}

// ─── Meses disponibles ────────────────────────────────────────────────────────
function getAvailableMonths() {
  const months = new Set();
  Object.keys(_data.monthly_sales).forEach(k => months.add(k.split('__')[1]));
  Object.keys(_data.monthly_ads).forEach(k   => months.add(k.split('__')[1]));
  return [...months].sort().reverse();
}

// ─── Datos de un mes ──────────────────────────────────────────────────────────
function getMonthData(month) {
  const products = getProducts();
  const result   = {};
  for (const p of products) {
    const s = getMonthlySales(p.id, month) || {};
    const a = getMonthlyAds(p.id, month)   || {};
    result[p.id] = {
      product:        p,
      units_ads:      a.units_ads      || 0,
      units_organic:  s.units_organic  || 0,
      units_returned: s.units_returned || 0,
      ppc_spend:      a.ppc_spend      || 0,
      storage_fee:    s.storage_fee    || 0,
      impressions:    a.impressions    || 0,
      clicks:         a.clicks         || 0,
    };
  }
  return result;
}

// ─── Sync ─────────────────────────────────────────────────────────────────────
const getLastSyncDate = () => _data.last_sync_date;
function setLastSyncDate(iso) {
  _data.last_sync_date = iso;
  save(_data);
}

function logSync(type, status, message, records = 0) {
  _data.sync_log.unshift({ type, status, message, records, started_at: new Date().toISOString() });
  _data.sync_log = _data.sync_log.slice(0, 100);
  save(_data);
}

const getLastSync = (type) => _data.sync_log.find(l => l.type === type) || null;

module.exports = {
  getProducts, upsertProduct, deleteProduct,
  getMonthlySales, upsertMonthlySales,
  getMonthlyAds, upsertMonthlyAds,
  getFixedCosts, upsertFixedCost, deleteFixedCost,
  getAvailableMonths, getMonthData,
  logSync, getLastSync,
  getLastSyncDate, setLastSyncDate,
};
