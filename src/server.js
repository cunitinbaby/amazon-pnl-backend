// ─── Servidor Express — Panel P&L Amazon FBA ─────────────────────────────────
try { require('dotenv').config(); } catch (e) {}

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const db = require('./db');
const { syncOrders, importSponsoredProductsCSV } = require('./sync');

const app  = express();
const PORT = process.env.PORT || 3001;

// Estado de la sincronización en memoria
let syncStatus = {
  running: false,
  lastRun: null,
  lastResult: null,
  lastError: null,
  logs: [],
};

function addLog(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  syncStatus.logs.unshift(entry);
  syncStatus.logs = syncStatus.logs.slice(0, 50); // Máx 50 líneas
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:        true,
    version:   '2.0.0',
    time:      new Date().toISOString(),
    products:  db.getProducts().length,
    months:    db.getAvailableMonths().length,
    env_ok:    !!(process.env.AMAZON_CLIENT_ID && process.env.AMAZON_REFRESH_TOKEN),
    sync:      { running: syncStatus.running, lastRun: syncStatus.lastRun, lastResult: syncStatus.lastResult },
  });
});

// ─── SYNC STATUS Y LOGS ───────────────────────────────────────────────────────
app.get('/api/sync/status', requireAuth, (req, res) => {
  res.json({
    running:    syncStatus.running,
    lastRun:    syncStatus.lastRun,
    lastResult: syncStatus.lastResult,
    lastError:  syncStatus.lastError,
    logs:       syncStatus.logs.slice(0, 20),
  });
});

// POST /api/sync — Lanza sincronización y espera resultado
app.post('/api/sync', requireAuth, async (req, res) => {
  if (syncStatus.running) {
    return res.json({ ok: false, running: true, message: 'Sincronización ya en curso' });
  }

  const { days = 60, wait = false } = req.body;

  if (wait) {
    // Modo espera: ejecuta y devuelve resultado cuando termina
    const result = await runSync(days);
    return res.json(result);
  } else {
    // Modo background: responde inmediatamente
    res.json({ ok: true, message: 'Sincronización iniciada' });
    runSync(days);
  }
});

async function runSync(days) {
  syncStatus.running = true;
  syncStatus.lastError = null;
  addLog(`▶ Iniciando sincronización (${days} días atrás)...`);

  try {
    const result = await syncOrders(days, addLog);
    syncStatus.lastResult = result;
    syncStatus.lastRun = new Date().toISOString();
    syncStatus.running = false;

    if (result.ok) {
      addLog(`✅ Completado: ${result.orders || 0} órdenes, ${result.records || 0} registros`);
    } else {
      addLog(`❌ Error: ${result.error}`);
      syncStatus.lastError = result.error;
    }
    return result;
  } catch (err) {
    syncStatus.running = false;
    syncStatus.lastError = err.message;
    addLog(`❌ Error fatal: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────
app.get('/api/products', requireAuth, (req, res) => {
  res.json({ products: db.getProducts() });
});

app.post('/api/products', requireAuth, (req, res) => {
  const { id, asin, name, price, fees, cogs, color } = req.body;
  if (!asin || !name) return res.status(400).json({ error: 'asin y name requeridos' });
  const pid = id || ('p_' + asin.replace(/[^a-z0-9]/gi, '').toLowerCase());
  db.upsertProduct({ id: pid, asin, name, price: price||0, fees: fees||0, cogs: cogs||0, color: color||'#FFB300' });
  res.json({ ok: true, id: pid });
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  db.deleteProduct(req.params.id);
  res.json({ ok: true });
});

// ─── DASHBOARD DATA ───────────────────────────────────────────────────────────
app.get('/api/dashboard/:month', requireAuth, (req, res) => {
  const { month } = req.params;
  const products   = db.getProducts();
  const fixedCosts = db.getFixedCosts();
  const monthData  = db.getMonthData(month);

  const productsCalc = {};
  let totalRevenue = 0, totalGross = 0, totalPPC = 0, totalStorage = 0, totalUnits = 0;

  for (const p of products) {
    const d = monthData[p.id] || {};
    const netUnits  = Math.max(0, (d.units_ads||0) + (d.units_organic||0) - (d.units_returned||0));
    const revenue   = netUnits * p.price;
    const feesTotal = netUnits * p.fees;
    const cogsTotal = netUnits * p.cogs;
    const gross     = netUnits * (p.price - p.fees - p.cogs);
    const adRev     = (d.units_ads||0) * p.price;
    const acos      = d.ppc_spend>0&&adRev>0    ? d.ppc_spend/adRev   : null;
    const tacos     = d.ppc_spend>0&&revenue>0  ? d.ppc_spend/revenue : null;
    const roas      = d.ppc_spend>0&&adRev>0    ? adRev/d.ppc_spend   : null;
    const margin    = p.price>0 ? (p.price-p.fees-p.cogs)/p.price : 0;

    productsCalc[p.id] = {
      product: p,
      units_ads:      d.units_ads      ||0,
      units_organic:  d.units_organic  ||0,
      units_returned: d.units_returned ||0,
      ppc_spend:      d.ppc_spend      ||0,
      storage_fee:    d.storage_fee    ||0,
      impressions:    d.impressions    ||0,
      clicks:         d.clicks         ||0,
      net_units: netUnits,
      revenue, fees_total: feesTotal, cogs_total: cogsTotal, gross,
      acos, tacos, roas, margin_pct: margin,
      net_pre_fixed: gross - (d.ppc_spend||0) - (d.storage_fee||0),
    };

    totalRevenue += revenue; totalGross += gross;
    totalPPC     += d.ppc_spend||0; totalStorage += d.storage_fee||0;
    totalUnits   += netUnits;
  }

  const totalFixed = fixedCosts.reduce((s,c)=>s+c.amount, 0);
  const netProfit  = totalGross - totalPPC - totalStorage - totalFixed;

  res.json({
    month, products: productsCalc,
    summary: { revenue: totalRevenue, gross: totalGross, ppc: totalPPC,
      storage: totalStorage, fixed: totalFixed, net: netProfit, units: totalUnits,
      tacos: totalPPC>0&&totalRevenue>0 ? totalPPC/totalRevenue : null,
      projection: netProfit*12,
    },
    fixed_costs: fixedCosts,
  });
});

app.get('/api/months', requireAuth, (req, res) => {
  res.json({ months: db.getAvailableMonths() });
});

// ─── MONTHLY DATA (manual entry) ─────────────────────────────────────────────
app.put('/api/monthly/:month/:productId', requireAuth, (req, res) => {
  const { month, productId } = req.params;
  const { units_organic, units_returned, ppc_spend, storage_fee, units_ads, impressions, clicks } = req.body;

  if (units_organic!=null || units_returned!=null || storage_fee!=null) {
    db.upsertMonthlySales({ product_id: productId, month,
      units_organic:  units_organic  ??0,
      units_returned: units_returned ??0,
      revenue: 0, storage_fee: storage_fee??0,
    });
  }
  if (ppc_spend!=null || units_ads!=null) {
    db.upsertMonthlyAds({ product_id: productId, month,
      units_ads:   units_ads   ??0,
      ppc_spend:   ppc_spend   ??0,
      impressions: impressions ??0,
      clicks:      clicks      ??0,
    });
  }
  res.json({ ok: true });
});

// ─── FIXED COSTS ─────────────────────────────────────────────────────────────
app.get('/api/fixed-costs', requireAuth, (req, res) => {
  res.json({ costs: db.getFixedCosts() });
});

app.post('/api/fixed-costs', requireAuth, (req, res) => {
  const { id, name, amount, category } = req.body;
  if (!name || amount==null) return res.status(400).json({ error: 'name y amount requeridos' });
  const cid = id || ('fc_'+Date.now());
  db.upsertFixedCost({ id: cid, name, amount: Number(amount), category: category||'otro' });
  res.json({ ok: true, id: cid });
});

app.delete('/api/fixed-costs/:id', requireAuth, (req, res) => {
  db.deleteFixedCost(req.params.id);
  res.json({ ok: true });
});

// ─── ADS CSV IMPORT ───────────────────────────────────────────────────────────
app.post('/api/import-ads-csv', requireAuth, async (req, res) => {
  const { csv, month } = req.body;
  if (!csv || !month) return res.status(400).json({ error: 'csv y month requeridos' });
  const result = await importSponsoredProductsCSV(csv, month);
  res.json(result);
});

// ─── ROOT ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ name: 'Panel P&L Amazon FBA Backend v2.0', status: 'online' });
});

// ─── INIT DATA ────────────────────────────────────────────────────────────────
function initDefaultData() {
  if (db.getProducts().length === 0) {
    db.upsertProduct({ id:'mordedor', asin:'B0DP5G5KGH', name:'Mordedor Bebé Pack 3',  price:8.09, fees:4.64, cogs:1.60, color:'#FFB300' });
    db.upsertProduct({ id:'cintas',   asin:'B0FCN2HK26', name:'Cintas Bucales Pack 30', price:7.99, fees:3.18, cogs:1.94, color:'#4C8CF5' });
    addLog('✅ Productos por defecto creados');
  }
  if (db.getFixedCosts().length === 0) {
    db.upsertFixedCost({ id:'f1', name:'Cuota autónomo',            amount:300, category:'fiscal'   });
    db.upsertFixedCost({ id:'f2', name:'Software (Helium 10 / JS)', amount:49,  category:'software' });
    db.upsertFixedCost({ id:'f3', name:'Gestoría',                  amount:60,  category:'fiscal'   });
    addLog('✅ Gastos fijos por defecto creados');
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Panel P&L Backend v2.0 — Puerto ${PORT}`);
  console.log(`✅ Amazon credentials: ${!!(process.env.AMAZON_CLIENT_ID && process.env.AMAZON_REFRESH_TOKEN) ? 'OK' : 'MISSING'}`);

  initDefaultData();

  // Cron automático cada noche a las 2am
  const cronExpr = process.env.SYNC_CRON || '0 2 * * *';
  try {
    cron.schedule(cronExpr, () => {
      addLog('⏰ Cron: sincronización automática iniciada');
      runSync(parseInt(process.env.SYNC_DAYS_BACK)||30);
    });
    console.log(`⏰ Cron: ${cronExpr}`);
  } catch(err) {
    console.error('Cron error:', err.message);
  }
});
