// ─── Servidor Express — Panel P&L Amazon FBA ─────────────────────────────────
// Sirve datos al dashboard web y gestiona la sincronización automática.
// Ejecutar con: node src/server.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const path    = require('path');

const db = require('./db');
const { syncOrders, importSponsoredProductsCSV } = require('./sync');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors()); // Permite que el dashboard (Netlify) acceda
app.use(express.json({ limit: '10mb' })); // Para importar CSVs grandes

// Autenticación simple por API key
function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ─── ENDPOINTS DE DATOS ───────────────────────────────────────────────────────

// GET /api/months — Meses disponibles
app.get('/api/months', requireAuth, (req, res) => {
  const months = db.getAvailableMonths();
  res.json({ months });
});

// GET /api/products — Lista de productos
app.get('/api/products', requireAuth, (req, res) => {
  const products = db.getProducts();
  res.json({ products });
});

// POST /api/products — Añadir/actualizar producto
app.post('/api/products', requireAuth, (req, res) => {
  const { id, asin, name, price, fees, cogs, color } = req.body;
  if (!asin || !name) return res.status(400).json({ error: 'asin y name son requeridos' });

  const productId = id || ('p_' + asin.replace(/[^a-z0-9]/gi, '').toLowerCase());
  db.upsertProduct({ id: productId, asin, name, price: price || 0, fees: fees || 0, cogs: cogs || 0, color: color || '#FFB300' });
  res.json({ ok: true, id: productId });
});

// DELETE /api/products/:id — Eliminar producto
app.delete('/api/products/:id', requireAuth, (req, res) => {
  db.deleteProduct(req.params.id);
  res.json({ ok: true });
});

// GET /api/dashboard/:month — Datos completos para el dashboard
app.get('/api/dashboard/:month', requireAuth, (req, res) => {
  const { month } = req.params; // "2026-04"
  const products  = db.getProducts();
  const fixedCosts = db.getFixedCosts();
  const monthData = db.getMonthData(month);

  // Calcular P&L por producto
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
    const acos      = d.ppc_spend > 0 && adRev > 0    ? d.ppc_spend / adRev  : null;
    const tacos     = d.ppc_spend > 0 && revenue > 0  ? d.ppc_spend / revenue : null;
    const roas      = d.ppc_spend > 0 && adRev > 0    ? adRev / d.ppc_spend   : null;
    const margin    = p.price > 0 ? (p.price - p.fees - p.cogs) / p.price : 0;

    productsCalc[p.id] = {
      product: p,
      units_ads:      d.units_ads      || 0,
      units_organic:  d.units_organic  || 0,
      units_returned: d.units_returned || 0,
      ppc_spend:      d.ppc_spend      || 0,
      storage_fee:    d.storage_fee    || 0,
      impressions:    d.impressions    || 0,
      clicks:         d.clicks         || 0,
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
      revenue:     totalRevenue,
      gross:       totalGross,
      ppc:         totalPPC,
      storage:     totalStorage,
      fixed:       totalFixed,
      net:         netProfit,
      units:       totalUnits,
      tacos:       totalPPC > 0 && totalRevenue > 0 ? totalPPC / totalRevenue : null,
      projection:  netProfit * 12,
    },
    fixed_costs: fixedCosts,
  });
});

// GET /api/fixed-costs — Gastos fijos
app.get('/api/fixed-costs', requireAuth, (req, res) => {
  res.json({ costs: db.getFixedCosts() });
});

// POST /api/fixed-costs — Añadir/actualizar gasto fijo
app.post('/api/fixed-costs', requireAuth, (req, res) => {
  const { id, name, amount, category } = req.body;
  if (!name || amount == null) return res.status(400).json({ error: 'name y amount son requeridos' });
  const costId = id || ('fc_' + Date.now());
  db.upsertFixedCost({ id: costId, name, amount: Number(amount), category: category || 'otro' });
  res.json({ ok: true, id: costId });
});

// DELETE /api/fixed-costs/:id — Eliminar gasto fijo
app.delete('/api/fixed-costs/:id', requireAuth, (req, res) => {
  db.deleteFixedCost(req.params.id);
  res.json({ ok: true });
});

// PUT /api/monthly/:month/:productId — Actualizar datos manuales de un mes
app.put('/api/monthly/:month/:productId', requireAuth, (req, res) => {
  const { month, productId } = req.params;
  const { units_organic, units_returned, ppc_spend, storage_fee, units_ads, impressions, clicks } = req.body;

  if (units_organic != null || units_returned != null || storage_fee != null) {
    db.upsertMonthlySales({
      product_id:     productId,
      month,
      units_organic:  units_organic  ?? 0,
      units_returned: units_returned ?? 0,
      revenue:        0, // se recalcula
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

// ─── ENDPOINTS DE SINCRONIZACIÓN ─────────────────────────────────────────────

// POST /api/sync — Lanza sincronización manual
app.post('/api/sync', requireAuth, async (req, res) => {
  const { days } = req.body;
  console.log('\n[API] Sincronización manual solicitada...');

  // Responder inmediatamente y sincronizar en segundo plano
  res.json({ ok: true, message: 'Sincronización iniciada en segundo plano' });

  syncOrders(days || parseInt(process.env.SYNC_DAYS_BACK) || 90)
    .then(result => console.log('[API] Sync completado:', result))
    .catch(err  => console.error('[API] Sync error:', err.message));
});

// POST /api/import-ads-csv — Importar CSV de Sponsored Products
app.post('/api/import-ads-csv', requireAuth, async (req, res) => {
  const { csv, month } = req.body;
  if (!csv || !month) return res.status(400).json({ error: 'csv y month son requeridos' });

  const result = await importSponsoredProductsCSV(csv, month);
  res.json(result);
});

// GET /api/sync/status — Estado de la última sincronización
app.get('/api/sync/status', requireAuth, (req, res) => {
  const lastOrders = db.getLastSync('orders');
  const lastAds    = db.getLastSync('ads_csv');
  res.json({ orders: lastOrders, ads: lastAds });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:       true,
    version:  '1.0.0',
    time:     new Date().toISOString(),
    products: db.getProducts().length,
    months:   db.getAvailableMonths().length,
  });
});

// ─── INICIALIZACIÓN BD ────────────────────────────────────────────────────────
function initDefaultData() {
  const products = db.getProducts();
  if (products.length === 0) {
    console.log('[Init] Insertando productos por defecto...');
    db.upsertProduct({ id:'mordedor', asin:'B0DP5G5KGH', name:'Mordedor Bebé Pack 3',  price:8.09, fees:4.64, cogs:1.60, color:'#FFB300' });
    db.upsertProduct({ id:'cintas',   asin:'B0FCN2HK26', name:'Cintas Bucales Pack 30', price:7.99, fees:3.18, cogs:1.94, color:'#4C8CF5' });
  }

  const costs = db.getFixedCosts();
  if (costs.length === 0) {
    console.log('[Init] Insertando gastos fijos por defecto...');
    db.upsertFixedCost({ id:'f1', name:'Cuota autónomo',            amount:300, category:'fiscal'   });
    db.upsertFixedCost({ id:'f2', name:'Software (Helium 10 / JS)', amount:49,  category:'software' });
    db.upsertFixedCost({ id:'f3', name:'Gestoría',                  amount:60,  category:'fiscal'   });
  }
}

// ─── ARRANCAR SERVIDOR ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n══════════════════════════════════════════════');
  console.log(' Panel P&L Amazon FBA — Backend v1.0');
  console.log('══════════════════════════════════════════════');
  console.log(`\n✅ Servidor en http://localhost:${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);

  initDefaultData();

  // ─── Cron: sincronización automática cada noche ───────────────────────────
  const cronExpr = process.env.SYNC_CRON || '0 2 * * *';
  cron.schedule(cronExpr, async () => {
    console.log('\n[Cron] ⏰ Iniciando sincronización automática...');
    await syncOrders(parseInt(process.env.SYNC_DAYS_BACK) || 30);
  });

  console.log(`\n⏰ Sincronización automática: ${cronExpr}`);
  console.log(`   (Por defecto: cada noche a las 2:00am)\n`);
});
