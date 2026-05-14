// ─── Sincronización Amazon SP-API (incremental) ──────────────────────────────
try { require('dotenv').config(); } catch (e) {}

const { fetchOrders, fetchOrderItems, aggregateOrdersByMonthAndAsin } = require('./orders');
const db = require('./db');
const { parseTSV } = require('./reports');
const axios = require('axios');
const { getHeaders } = require('./auth');

const BASE = process.env.AMAZON_ENDPOINT;
const MKT  = process.env.AMAZON_MARKETPLACE_ID;

// Auto-añadir productos nuevos detectados en las órdenes
async function autoAddProduct(asin, log) {
  try {
    const headers = await getHeaders();
    const res = await axios.get(`${BASE}/catalog/2022-04-01/items/${asin}`, {
      headers,
      params: { marketplaceIds: MKT, includedData: 'summaries,attributes' }
    });

    const summary = res.data.summaries?.[0] || {};
    const title = summary.itemName || `Producto ${asin}`;

    db.upsertProduct({
      id:    'p_' + asin.toLowerCase(),
      asin,
      name:  title.slice(0, 60),
      price: 0,  // El usuario debe completar
      fees:  0,
      cogs:  0,
      color: '#A78BFA',
    });

    log(`🆕 Nuevo producto detectado: ${asin} — ${title.slice(0, 40)}`);
    log(`⚠️ Completa precio, fees y COGS en la pestaña Productos`);
    return true;
  } catch (err) {
    log(`⚠️ No se pudo añadir ${asin}: ${err.message}`);
    // Añadir con datos vacíos
    db.upsertProduct({
      id:    'p_' + asin.toLowerCase(),
      asin,
      name:  `Producto ${asin}`,
      price: 0, fees: 0, cogs: 0, color: '#A78BFA',
    });
    return false;
  }
}

async function syncOrders(daysBack = null, log = console.log) {
  const start = Date.now();

  if (!process.env.AMAZON_CLIENT_ID || !process.env.AMAZON_REFRESH_TOKEN) {
    log('❌ ERROR: Faltan credenciales de Amazon');
    return { ok: false, error: 'Faltan credenciales' };
  }

  // SYNC INCREMENTAL: usar última sync + 1h overlap para no perder datos
  let startDate;
  const lastSync = db.getLastSyncDate();

  if (daysBack) {
    // Sync forzado completo (primera vez o reset)
    startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    log(`📅 Sync completo: últimos ${daysBack} días`);
  } else if (lastSync) {
    // Sync incremental: desde última fecha - 1 hora de margen
    startDate = new Date(lastSync);
    startDate.setHours(startDate.getHours() - 1);
    log(`⚡ Sync incremental desde: ${startDate.toISOString().slice(0, 16)}`);
  } else {
    // Primera sync: últimos 60 días
    startDate = new Date();
    startDate.setDate(startDate.getDate() - 60);
    log(`📅 Primera sync: últimos 60 días`);
  }

  const endDate = new Date();

  try {
    log('📥 Descargando órdenes...');
    const orders = await fetchOrders(startDate, endDate, log);
    log(`📥 ${orders.length} órdenes descargadas`);

    if (orders.length === 0) {
      db.setLastSyncDate(endDate.toISOString());
      log('ℹ️ Sin órdenes nuevas');
      return { ok: true, orders: 0, records: 0 };
    }

    // Detectar ASINs en las órdenes
    log(`📥 Descargando items (1 cada 2.1s)...`);
    const orderItemsMap = {};
    const allAsins = new Set();

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const items = await fetchOrderItems(order.AmazonOrderId, log);
      orderItemsMap[order.AmazonOrderId] = items;
      items.forEach(it => it.ASIN && allAsins.add(it.ASIN));

      if ((i + 1) % 10 === 0) {
        log(`📥 Items: ${i + 1}/${orders.length}`);
      }
    }

    // Auto-añadir productos nuevos
    const existingAsins = new Set(db.getProducts().map(p => p.asin));
    const newAsins = [...allAsins].filter(a => !existingAsins.has(a));

    if (newAsins.length > 0) {
      log(`🆕 ${newAsins.length} ASIN(s) nuevo(s) detectado(s)`);
      for (const asin of newAsins) {
        await autoAddProduct(asin, log);
      }
    }

    // Agregar y guardar
    const products = db.getProducts();
    const asinMap = Object.fromEntries(products.map(p => [p.asin, p]));
    const aggregated = aggregateOrdersByMonthAndAsin(orders, orderItemsMap);

    let savedRecords = 0;
    for (const [month, asins] of Object.entries(aggregated)) {
      for (const [asin, data] of Object.entries(asins)) {
        const product = asinMap[asin];
        if (!product) continue;

        const existing = db.getMonthlySales(product.id, month) || {};

        db.upsertMonthlySales({
          product_id:     product.id,
          month,
          units_organic:  Math.max(existing.units_organic || 0, data.units),
          units_returned: Math.max(existing.units_returned || 0, data.returns),
          revenue:        Math.max(existing.revenue || 0, data.revenue),
          storage_fee:    existing.storage_fee || 0,
        });
        savedRecords++;
      }
    }

    db.setLastSyncDate(endDate.toISOString());

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`✅ Sync completado en ${elapsed}s — ${savedRecords} registros`);

    return { ok: true, orders: orders.length, records: savedRecords, newProducts: newAsins.length };

  } catch (err) {
    log(`❌ Error: ${err.message}`);
    if (err.response) log(`❌ Amazon: ${err.response.status} — ${JSON.stringify(err.response.data||{}).slice(0,200)}`);
    return { ok: false, error: err.message };
  }
}

async function importSponsoredProductsCSV(csvContent, month, log = console.log) {
  log(`📥 Importando CSV para ${month}...`);

  try {
    const isTSV = csvContent.includes('\t');
    let rows;

    if (isTSV) {
      rows = parseTSV(csvContent);
    } else {
      const lines = csvContent.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      rows = lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
        return Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
      });
    }

    const products = db.getProducts();
    const asinMap  = Object.fromEntries(products.map(p => [p.asin, p]));
    const byAsin   = {};

    for (const row of rows) {
      const asin = row['ASIN'] || row['asin'] || row['Product ASIN'] || row['Advertised ASIN'] || row['Advertised product ASIN'];
      if (!asin || !asinMap[asin]) continue;

      if (!byAsin[asin]) byAsin[asin] = { units_ads:0, ppc_spend:0, impressions:0, clicks:0 };
      byAsin[asin].units_ads   += Number(row['Units Sold']||row['7 Day Total Units']||row['Unidades vendidas en 7 días']||0);
      byAsin[asin].ppc_spend   += Number(row['Spend']||row['Gasto']||row['Total Spend']||0);
      byAsin[asin].impressions += Number(row['Impressions']||row['Impresiones']||0);
      byAsin[asin].clicks      += Number(row['Clicks']||row['Clics']||0);
    }

    let saved = 0;
    for (const [asin, data] of Object.entries(byAsin)) {
      const product = asinMap[asin];
      db.upsertMonthlyAds({ product_id: product.id, month, ...data });
      log(`✅ PPC: ${product.name} — €${data.ppc_spend.toFixed(2)}`);
      saved++;
    }

    log(`✅ CSV: ${saved} productos para ${month}`);
    return { ok: true, saved, rows: rows.length };

  } catch (err) {
    log(`❌ Error CSV: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

if (require.main === module) {
  syncOrders(null, console.log)
    .then(r => { console.log('Resultado:', r); process.exit(r.ok?0:1); })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { syncOrders, importSponsoredProductsCSV };
