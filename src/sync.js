try { require('dotenv').config(); } catch (e) {}

const { fetchOrders, fetchOrderItems, aggregateOrdersByDateAndAsin } = require('./orders');
const db = require('./db');
const { parseTSV } = require('./reports');
const axios = require('axios');
const { getHeaders } = require('./auth');

const BASE = process.env.AMAZON_ENDPOINT;
const MKT  = process.env.AMAZON_MARKETPLACE_ID;

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
      price: 0, fees: 0, cogs: 0,
      color: '#A78BFA',
    });

    log(`🆕 ${asin} — ${title.slice(0, 40)}`);
    return true;
  } catch (err) {
    log(`⚠️ Auto-add ${asin}: ${err.message}`);
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
    log('❌ Faltan credenciales');
    return { ok: false, error: 'Credenciales incompletas' };
  }

  let startDate;
  const lastSync = db.getLastSyncDate();

  if (daysBack) {
    startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    log(`📅 Sync completo: ${daysBack} días`);
  } else if (lastSync) {
    startDate = new Date(lastSync);
    startDate.setHours(startDate.getHours() - 1);
    log(`⚡ Incremental desde ${startDate.toISOString().slice(0, 16)}`);
  } else {
    startDate = new Date();
    startDate.setDate(startDate.getDate() - 60);
    log(`📅 Primera sync: 60 días`);
  }

  const endDate = new Date();

  try {
    log('📥 Descargando órdenes...');
    const orders = await fetchOrders(startDate, endDate, log);
    log(`📥 ${orders.length} órdenes`);

    if (orders.length === 0) {
      db.setLastSyncDate(endDate.toISOString());
      return { ok: true, orders: 0, records: 0 };
    }

    log(`📥 Descargando items (1 cada 2.1s)...`);
    const orderItemsMap = {};
    const allAsins = new Set();

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const items = await fetchOrderItems(order.AmazonOrderId, log);
      orderItemsMap[order.AmazonOrderId] = items;
      items.forEach(it => it.ASIN && allAsins.add(it.ASIN));

      if ((i + 1) % 10 === 0) log(`  ${i + 1}/${orders.length}`);
      await new Promise(r => setTimeout(r, 2100));
    }

    // Auto-añadir productos nuevos
    const existingAsins = new Set(db.getProducts().map(p => p.asin));
    const newAsins = [...allAsins].filter(a => !existingAsins.has(a));

    if (newAsins.length > 0) {
      log(`🆕 ${newAsins.length} ASIN(s) nuevo(s)`);
      for (const asin of newAsins) await autoAddProduct(asin, log);
    }

    // Agregar por fecha
    const products = db.getProducts();
    const asinMap = Object.fromEntries(products.map(p => [p.asin, p]));
    const byDateAsin = aggregateOrdersByDateAndAsin(orders, orderItemsMap);

    let savedRecords = 0;
    for (const [key, data] of Object.entries(byDateAsin)) {
      const [date, asin] = key.split('::');
      const product = asinMap[asin];
      if (!product) continue;

      const existing = db.getDailySales(product.id, date) || {};

      db.upsertDailySales({
        product_id:     product.id,
        date,
        units_organic:  Math.max(existing.units_organic || 0, data.units),
        units_returned: Math.max(existing.units_returned || 0, data.returns),
        revenue:        Math.max(existing.revenue || 0, data.revenue),
        storage_fee:    existing.storage_fee || 0,
      });
      savedRecords++;
    }

    db.setLastSyncDate(endDate.toISOString());

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`✅ ${elapsed}s · ${savedRecords} registros`);

    return { ok: true, orders: orders.length, records: savedRecords, newProducts: newAsins.length };

  } catch (err) {
    log(`❌ ${err.message}`);
    if (err.response) log(`❌ ${err.response.status}`);
    return { ok: false, error: err.message };
  }
}

async function importSponsoredProductsCSV(csvContent, month, log = console.log) {
  log(`📥 CSV para ${month}...`);
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
    const asinMap = Object.fromEntries(products.map(p => [p.asin, p]));
    const byAsin = {};

    for (const row of rows) {
      const asin = row['ASIN'] || row['asin'] || row['Product ASIN'] || row['Advertised ASIN'];
      if (!asin || !asinMap[asin]) continue;

      if (!byAsin[asin]) byAsin[asin] = { units_ads: 0, ppc_spend: 0 };
      byAsin[asin].units_ads += Number(row['Units Sold'] || row['7 Day Total Units'] || 0);
      byAsin[asin].ppc_spend += Number(row['Spend'] || row['Gasto'] || 0);
    }

    let saved = 0;
    for (const [asin, data] of Object.entries(byAsin)) {
      const product = asinMap[asin];
      db.upsertMonthlyAds({ product_id: product.id, month, ...data });
      log(`✅ ${product.name} — €${data.ppc_spend.toFixed(2)}`);
      saved++;
    }

    log(`✅ ${saved} productos`);
    return { ok: true, saved };

  } catch (err) {
    log(`❌ CSV: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

if (require.main === module) {
  syncOrders(null, console.log)
    .then(r => { console.log('OK:', r); process.exit(r.ok?0:1); })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { syncOrders, importSponsoredProductsCSV };
