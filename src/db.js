// ─── Base de datos JSON ──────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'pnl.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_DATA = {
  products: [], daily_sales: {}, monthly_ads: {},
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
if (!_data.last_sync_date) _data.last_sync_date = null;
if (!_data.daily_sales) _data.daily_sales = {};
if (!_data.monthly_ads) _data.monthly_ads = {};

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

// ─── Ventas diarias ──────────────────────────────────────────────────────────
const getDailySales = (pid, date) => {
  const key = `${pid}__${date}`;
  return _data.daily_sales[key] || null;
};

function upsertDailySales(d) {
  const key = `${d.product_id}__${d.date}`;
  _data.daily_sales[key] = d;
  save(_data);
}

// ─── Agregación por mes (para dashboard) ──────────────────────────────────────
function getDailySalesByMonth(pid, month) {
  const result = { units_organic: 0, units_returned: 0, revenue: 0, storage_fee: 0 };
  const prefix = `${pid}__${month}`;
  for (const [key, val] of Object.entries(_data.daily_sales)) {
    if (key.startsWith(prefix)) {
      result.units_organic  += val.units_organic || 0;
      result.units_returned += val.units_returned || 0;
      result.revenue        += val.revenue || 0;
      result.storage_fee    += val.storage_fee || 0;
    }
  }
  return result;
}

// ─── Ventas en rango de fechas ───────────────────────────────────────────────
function getDailySalesByDateRange(pid, startDate, endDate) {
  const result = { units_organic: 0, units_returned: 0, revenue: 0, storage_fee: 0 };
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  for (const [key, val] of Object.entries(_data.daily_sales)) {
    if (!key.startsWith(pid)) continue;
    const date = key.split('__')[1];
    const t = new Date(date).getTime();
    if (t >= start && t <= end) {
      result.units_organic  += val.units_organic || 0;
      result.units_returned += val.units_returned || 0;
      result.revenue        += val.revenue || 0;
      result.storage_fee    += val.storage_fee || 0;
    }
  }
  return result;
}

// ─── Ads (por mes) ───────────────────────────────────────────────────────────
const getMonthlyAds = (pid, m) => {
  const key = `${pid}__${m}`;
  return _data.monthly_ads[key] || null;
};

function upsertMonthlyAds(d) {
  _data.monthly_ads[`${d.product_id}__${d.month}`] = d;
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
  for (const key of Object.keys(_data.daily_sales)) {
    const date = key.split('__')[1];
    if (date) months.add(date.slice(0, 7)); // YYYY-MM
  }
  for (const key of Object.keys(_data.monthly_ads)) {
    const month = key.split('__')[1];
    if (month) months.add(month);
  }
  return [...months].sort().reverse();
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
  getDailySales, upsertDailySales, getDailySalesByMonth, getDailySalesByDateRange,
  getMonthlyAds, upsertMonthlyAds,
  getFixedCosts, upsertFixedCost, deleteFixedCost,
  getAvailableMonths,
  logSync, getLastSync,
  getLastSyncDate, setLastSyncDate,
};
