// ─── Express Server ────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { syncOrders, importSponsoredProductsCSV } = require('./sync');
const db = require('./db');

try { require('dotenv').config(); } catch (e) {}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const PORT = process.env.PORT || 8080;
const API_SECRET = process.env.API_SECRET || 'secret';

// ─── Auth Middleware ──────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== API_SECRET) return res.status(401).json({ok:false});
  next();
};

// ─── Sync State ────────────────────────────────────────────────────────────
let syncStatus = { running: false, lastError: null, startedAt: null };
const syncLogs = [];

function addLog(msg) {
  syncLogs.unshift(msg);
  syncLogs.splice(100); // Keep last 100
}

async function runSync(days) {
  if (syncStatus.running) return { running: true };

  syncStatus.running = true;
  syncStatus.lastError = null;
  syncStatus.startedAt = new Date().toISOString();

  try {
    if (days === null) addLog(`▶ Sync incremental`);
    else addLog(`▶ Sync ${days} días`);

    const result = await syncOrders(days, addLog);

    if (result.ok) {
      syncStatus.lastError = null;
      addLog(`✅ OK`);
    } else {
      syncStatus.lastError = result.error;
      addLog(`❌ ${result.error}`);
    }

    return result;
  } catch (err) {
    syncStatus.lastError = err.message;
    addLog(`❌ ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    syncStatus.running = false;
  }
}

// ─── Cron automático cada 10 minutos (sync incremental) ───────────────────
const cronExpr = process.env.SYNC_CRON || '*/10 * * * *';
try {
  cron.schedule(cronExpr, () => {
    if (syncStatus.running) return;
    addLog('⏰ Cron auto: sync incremental');
    runSync(null);
  });
  console.log(`⏰ Cron: ${cronExpr}`);
} catch(err) {
  console.error('Cron error:', err.message);
}

// ─── Health Check ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const products = db.getProducts().length;
  res.json({
    ok: true,
    env_ok: !!process.env.AMAZON_CLIENT_ID,
    products,
    sync: {
      running: syncStatus.running,
      lastRun: syncStatus.startedAt,
      lastError: syncStatus.lastError,
    }
  });
});

// ─── Products ──────────────────────────────────────────────────────────────
app.get('/api/products', requireAuth, (req, res) => {
  res.json({ products: db.getProducts() });
});

app.post('/api/products', requireAuth, (req, res) => {
  const { id, asin, name, price, fees, cogs, color } = req.body;
  if (!asin || !name) return res.status(400).json({error:'asin y name requeridos'});

  const pid = id || 'p_' + asin.toLowerCase();
  db.upsertProduct({ id: pid, asin, name, price, fees, cogs, color });
  res.json({ id: pid });
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  db.deleteProduct(req.params.id);
  res.json({ok:true});
});

// ─── Months ────────────────────────────────────────────────────────────────
app.get('/api/months', requireAuth, (req, res) => {
  res.json({ months: db.getAvailableMonths() });
});

// ─── Dashboard por mes ─────────────────────────────────────────────────────
app.get('/api/dashboard/:month', requireAuth, (req, res) => {
  const { month } = req.params;
  const products = db.getProducts();
  const result = { month, products: {} };

  for (const p of products) {
    const sales = db.getDailySalesByMonth(p.id, month) || {};
    const ads = db.getMonthlyAds(p.id, month) || {};
    result.products[p.id] = {
      units_ads:      ads.units_ads      || 0,
      units_organic:  sales.units_organic  || 0,
      units_returned: sales.units_returned || 0,
      ppc_spend:      ads.ppc_spend      || 0,
      storage_fee:    sales.storage_fee    || 0,
    };
  }

  res.json(result);
});

// ─── Dashboard por rango de fechas (para Hoy, 30 días, etc) ────────────────
app.get('/api/dashboard-range', requireAuth, (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({error: 'Falta start y end'});

  const products = db.getProducts();
  const result = { start, end, products: {} };

  for (const p of products) {
    const sales = db.getDailySalesByDateRange(p.id, start, end) || {};
    result.products[p.id] = {
      units_ads:      0,
      units_organic:  sales.units_organic  || 0,
      units_returned: sales.units_returned || 0,
      ppc_spend:      0,
      storage_fee:    sales.storage_fee    || 0,
    };
  }

  res.json(result);
});

// ─── Monthly Ads (manual PPC) ──────────────────────────────────────────────
app.put('/api/monthly/:month/:product_id', requireAuth, (req, res) => {
  const { month, product_id } = req.params;
  const { units_ads, ppc_spend, storage_fee } = req.body;

  db.upsertMonthlyAds({
    product_id,
    month,
    units_ads: units_ads || 0,
    ppc_spend: ppc_spend || 0,
  });

  res.json({ok:true});
});

// ─── Fixed Costs ───────────────────────────────────────────────────────────
app.get('/api/fixed-costs', requireAuth, (req, res) => {
  res.json({ costs: db.getFixedCosts() });
});

app.post('/api/fixed-costs', requireAuth, (req, res) => {
  const { id, name, amount, category } = req.body;
  if (!name) return res.status(400).json({error:'name requerido'});

  const cid = id || 'fc_' + Date.now();
  db.upsertFixedCost({ id: cid, name, amount, category });
  res.json({ id: cid });
});

app.delete('/api/fixed-costs/:id', requireAuth, (req, res) => {
  db.deleteFixedCost(req.params.id);
  res.json({ok:true});
});

// ─── Sync ──────────────────────────────────────────────────────────────────
app.post('/api/sync', requireAuth, async (req, res) => {
  const { days = null, wait = false } = req.body;

  if (wait) {
    // Esperar a que termine
    const result = await runSync(days);
    return res.json(result);
  }

  // Fire and forget
  runSync(days);
  res.json({ running: true });
});

app.get('/api/sync/status', requireAuth, (req, res) => {
  res.json({
    running: syncStatus.running,
    lastRun: syncStatus.startedAt,
    lastError: syncStatus.lastError,
    logs: syncLogs,
  });
});

// ─── Listen ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
});

module.exports = app;
