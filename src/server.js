// ─── Servidor Express — Panel P&L Amazon FBA ─────────────────────────────────
// Versión Railway-friendly: sin dependencias nativas.

// Cargar .env si existe (Railway inyecta variables directamente, así que no falla)
try { require('dotenv').config(); } catch (e) { /* ignore */ }

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const db = require('./db');
const { syncOrders, importSponsoredProductsCSV } = require('./sync');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Autenticación por API key
function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    ok:       true,
    version:  '1.0.0',
    time:     new Date().toISOString(),
    products: db.getProducts().length,
    months:   db.getAvailableMonths().length,
    env_ok:   !!(process.env.AMAZON_CLIENT_ID && process.env.AMAZON_REFRESH_TOKEN),
  });
});

app.get('/api/months', requireAuth, (req, res) => {
  res.json({ months: db.getAvailableMonths() });
});

app.get('/api/products', requireAuth, (req, res) => {
  res.json({ products: db.getProducts() });
});

app.post('/api/products', requireAuth, (req, res) => {
  const { id, asin, name, price, fees, cogs, color } = req.body;
  if (!asin || !name) return res.status(400).json({ error: 'asin y name son requeridos' });
  const productId = id || ('p_' + asin.replace(/[^a-z0-9]/gi, '').toLowerCase());
  db.upsertProduct({ id: productId, asin, name, price: price || 0, fees: fees || 0, cogs: cogs || 0, color: color || '#FFB300' });
  res.json({ ok: true, id: productId });
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  db.deleteProduct(req.params.id);
  res.json({ ok: true });
});

app.get('/api/dashboard/:month', requireAuth, (req, res) => {
  const { month } = req.params;
  const products  = db.getProducts();
  const fixedCosts = db.getFixedCosts();
  const monthData = db.getMonthData(month);

  const productsCalc = {};
  let totalRevenue = 0, totalGross = 0, totalPPC = 0, totalStorage = 0, totalUnits = 0;

  for (const p of products) {
    const d = monthData[p.id] || {};
    const netUnits  = Math.max(0, (d.units_ads || 0) + (d.units_organic || 0) - (d.units_returned || 0));
    const revenue   = netUnits * p.price;
    const feesTotal = netUnits * p.fees;
    const cogsTotal = netUnits * p.cogs;
    const gross     = netUnits * (p.price - p.fees - p.cogs);
    const adRev     = (d.units_ads || 0) * p.price;
    const acos      = d.ppc_spend > 0 && adRev > 0    ? d.ppc_spend / adRev   : null;
    const tacos     = d.ppc_spend > 0 && revenue > 0  ? d.ppc_spend / revenue : null;
    const roas      = d.ppc_spend > 0 && adRev > 0    ? adRev / d.ppc_spend   : null;
    const margin    = p.price > 0 ? (p.price - p.fees - p.cogs) / p.price : 0;

    productsCalc[p.id] = {
      product: p,
      ...d,
      net_units: netUnits,
      revenue, fees_total: feesTotal, cogs_total: cogsTotal, gross,
      acos, tacos, roas, margin_pct: margin,
      net_pre_fixed: gross - (d.ppc_spend || 0) - (d.storage_fee || 0),
    };

    totalRevenue  += revenue;
    totalGross    += gross;
    totalPPC      += d.ppc_spend    || 0;
    totalStorage  += d.storage_fee  || 0;
    totalUnits    += netUnits;
  }

  const totalFixed = fixedCosts.reduce((s, c) => s + c.amount, 0);
  const netProfit  = totalGross - totalPPC - totalStorage - totalFixed;

  res.json({
    month,
    products: productsCalc,
    summary: {
      revenue:    totalRevenue,
      gross:      totalGross,
      ppc:        totalPPC,
      storage:    totalStorage,
      fixed:      totalFixed,
      net:        netProfit,
      units:      totalUnits,
      tacos:      totalPPC > 0 && totalRevenue > 0 ? totalPPC / totalRevenue : null,
      projection: netProfit * 12,
    },
    fixed_costs: fixedCosts,
  });
});

app.get('/api/fixed-costs', requireAuth, (req, res) => {
  res.json({ costs: db.getFixedCosts() });
});

app.post('/api/fixed-costs', requireAuth, (req, res) => {
  const { id, name, amount, category } = req.body;
  if (!name || amount == null) return res.status(400).json({ error: 'name y amount son requeridos' });
  const costId = id || ('fc_' + Date.now());
  db.upsertFixedCost({ id: costId, name, amount: Number(amount), category: category || 'otro' });
  res.json({ ok: true, id: costId });
});

app.delete('/api/fixed-costs/:id', requireAuth, (req, res) => {
  db.deleteFixedCost(req.params.id);
  res.json({ ok: true });
});

app.put('/api/monthly/:month/:productId', requireAuth, (req, res) => {
  const { month, productId } = req.params;
  const { units_organic, units_returned, ppc_spend, storage_fee, units_ads, impressions, clicks } = req.body;

  if (units_organic != null || units_returned != null || storage_fee != null) {
    db.upsertMonthlySales({
      product_id:     productId,
      month,
      units_organic:  units_organic  ?? 0,
      units_returned: units_returned ?? 0,
      revenue:        0,
      storage_fee:    storage_fee    ?? 0,
    });
  }

  if (ppc_spend != null || units_ads != null) {
    db.upsertMonthlyAds({
      product_id:  productId,
      month,
      units_ads:   units_ads   ?? 0,
      ppc_spend:   ppc_spend   ?? 0,
      impressions: impressions ?? 0,
      clicks:      clicks      ?? 0,
    });
  }

  res.json({ ok: true });
});

app.post('/api/sync', requireAuth, async (req, res) => {
  const { days } = req.body;
  res.json({ ok: true, message: 'Sincronización iniciada en segundo plano' });
  syncOrders(days || parseInt(process.env.SYNC_DAYS_BACK) || 90)
    .then(result => console.log('[API] Sync completado:', result))
    .catch(err  => console.error('[API] Sync error:', err.message));
});

app.post('/api/import-ads-csv', requireAuth, async (req, res) => {
  const { csv, month } = req.body;
  if (!csv || !month) return res.status(400).json({ error: 'csv y month son requeridos' });
  const result = await importSponsoredProductsCSV(csv, month);
  res.json(result);
});

app.get('/api/sync/status', requireAuth, (req, res) => {
  res.json({
    orders: db.getLastSync('orders'),
    ads:    db.getLastSync('ads_csv'),
  });
});

// Ruta raíz
app.get('/', (req, res) => {
  res.json({
    name: 'Panel P&L Amazon FBA Backend',
    version: '1.0.0',
    endpoints: ['/health', '/api/dashboard/:month', '/api/products', '/api/sync'],
  });
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
function initDefaultData() {
  if (db.getProducts().length === 0) {
    console.log('[Init] Insertando productos por defecto...');
    db.upsertProduct({ id:'mordedor', asin:'B0DP5G5KGH', name:'Mordedor Bebé Pack 3',  price:8.09, fees:4.64, cogs:1.60, color:'#FFB300' });
    db.upsertProduct({ id:'cintas',   asin:'B0FCN2HK26', name:'Cintas Bucales Pack 30', price:7.99, fees:3.18, cogs:1.94, color:'#4C8CF5' });
  }
  if (db.getFixedCosts().length === 0) {
    console.log('[Init] Insertando gastos fijos por defecto...');
    db.upsertFixedCost({ id:'f1', name:'Cuota autónomo',            amount:300, category:'fiscal'   });
    db.upsertFixedCost({ id:'f2', name:'Software (Helium 10 / JS)', amount:49,  category:'software' });
    db.upsertFixedCost({ id:'f3', name:'Gestoría',                  amount:60,  category:'fiscal'   });
  }
}

// ─── ARRANCAR ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n══════════════════════════════════════════════');
  console.log(' Panel P&L Amazon FBA — Backend v1.0');
  console.log('══════════════════════════════════════════════');
  console.log(`✅ Servidor en puerto ${PORT}`);
  console.log(`✅ Health check: /health`);
  console.log(`✅ Env Amazon OK: ${!!(process.env.AMAZON_CLIENT_ID && process.env.AMAZON_REFRESH_TOKEN)}`);

  initDefaultData();

  const cronExpr = process.env.SYNC_CRON || '0 2 * * *';
  try {
    cron.schedule(cronExpr, async () => {
      console.log('\n[Cron] ⏰ Iniciando sincronización automática...');
      await syncOrders(parseInt(process.env.SYNC_DAYS_BACK) || 30);
    });
    console.log(`⏰ Sync automático: ${cronExpr}`);
  } catch (err) {
    console.error('[Cron] Error configurando cron:', err.message);
  }
});
