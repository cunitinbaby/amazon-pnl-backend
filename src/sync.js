// ─── Sincronización con Amazon SP-API ────────────────────────────────────────
try { require('dotenv').config(); } catch (e) { /* ignore */ }

const {
  fetchOrders, fetchOrderItems, aggregateOrdersByMonthAndAsin
} = require('./orders');

const {
  getProducts, upsertMonthlySales, upsertMonthlyAds, logSync
} = require('./db');

const { parseTSV } = require('./reports');

async function syncOrders(daysBack = null) {
  const start = Date.now();
  console.log('\n[Sync] Iniciando sincronización Amazon SP-API...');

  try {
    const endDate   = new Date();
    const startDate = new Date();

    if (daysBack) {
      startDate.setDate(startDate.getDate() - daysBack);
    } else {
      startDate.setDate(1);
      startDate.setMonth(startDate.getMonth() - 1);
    }

    console.log(`[Sync] Período: ${startDate.toISOString().slice(0,10)} → ${endDate.toISOString().slice(0,10)}`);

    const products = getProducts();
    if (products.length === 0) {
      logSync('orders', 'error', 'No hay productos en BD', 0);
      return { ok: false, error: 'No hay productos en la BD' };
    }

    const asinMap = Object.fromEntries(products.map(p => [p.asin, p]));
    console.log(`[Sync] Productos: ${products.map(p => p.asin).join(', ')}`);

    const orders = await fetchOrders(startDate, endDate);
    console.log(`[Sync] ✓ ${orders.length} órdenes descargadas`);

    if (orders.length === 0) {
      logSync('orders', 'ok', 'Sin órdenes en el período', 0);
      return { ok: true, orders: 0 };
    }

    console.log('[Sync] Descargando items...');
    const orderItemsMap = {};
    const BATCH = 5;

    for (let i = 0; i < orders.length; i += BATCH) {
      const batch = orders.slice(i, i + BATCH);
      await Promise.all(batch.map(async (order) => {
        try {
          const items = await fetchOrderItems(order.AmazonOrderId);
          orderItemsMap[order.AmazonOrderId] = items;
        } catch (err) {
          console.warn(`[Sync] Items fallo: ${order.AmazonOrderId}`);
        }
      }));
    }

    const aggregated = aggregateOrdersByMonthAndAsin(orders, orderItemsMap);

    let savedRecords = 0;
    for (const [month, asins] of Object.entries(aggregated)) {
      for (const [asin, data] of Object.entries(asins)) {
        const product = asinMap[asin];
        if (!product) continue;

        upsertMonthlySales({
          product_id:     product.id,
          month,
          units_organic:  data.units,
          units_returned: data.returns,
          revenue:        data.revenue,
          storage_fee:    0,
        });
        savedRecords++;
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[Sync] ✅ Completado en ${elapsed}s — ${savedRecords} registros`);
    logSync('orders', 'ok', `${orders.length} órdenes`, savedRecords);

    return { ok: true, orders: orders.length, records: savedRecords };

  } catch (err) {
    console.error('[Sync] ❌ Error:', err.message);
    if (err.response) console.error('[Sync] Amazon:', JSON.stringify(err.response.data));
    logSync('orders', 'error', err.message, 0);
    return { ok: false, error: err.message };
  }
}

async function importSponsoredProductsCSV(csvContent, month) {
  console.log(`[Import] Importando CSV Sponsored Products para ${month}...`);

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

    const products = getProducts();
    const asinMap  = Object.fromEntries(products.map(p => [p.asin, p]));

    const byAsin = {};
    for (const row of rows) {
      const asin = row['ASIN'] || row['asin'] || row['Product ASIN'] || row['Advertised ASIN'];
      if (!asin || !asinMap[asin]) continue;

      if (!byAsin[asin]) byAsin[asin] = { units_ads: 0, ppc_spend: 0, impressions: 0, clicks: 0 };

      byAsin[asin].units_ads   += Number(row['Units Sold'] || row['7 Day Total Units'] || row['Unidades vendidas en 7 días'] || 0);
      byAsin[asin].ppc_spend   += Number(row['Spend'] || row['Gasto'] || row['Total Spend'] || 0);
      byAsin[asin].impressions += Number(row['Impressions'] || row['Impresiones'] || 0);
      byAsin[asin].clicks      += Number(row['Clicks'] || row['Clics'] || 0);
    }

    let saved = 0;
    for (const [asin, data] of Object.entries(byAsin)) {
      const product = asinMap[asin];
      upsertMonthlyAds({ product_id: product.id, month, ...data });
      saved++;
    }

    console.log(`[Import] ✅ ${saved} productos actualizados`);
    logSync('ads_csv', 'ok', `CSV importado ${month}`, saved);

    return { ok: true, saved, rows: rows.length };

  } catch (err) {
    console.error('[Import] ❌ Error:', err.message);
    logSync('ads_csv', 'error', err.message, 0);
    return { ok: false, error: err.message };
  }
}

if (require.main === module) {
  const days = parseInt(process.env.SYNC_DAYS_BACK) || 90;
  syncOrders(days)
    .then(result => {
      console.log('Resultado:', result);
      process.exit(result.ok ? 0 : 1);
    })
    .catch(err => {
      console.error('Error fatal:', err);
      process.exit(1);
    });
}

module.exports = { syncOrders, importSponsoredProductsCSV };
