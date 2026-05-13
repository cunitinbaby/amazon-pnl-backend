// ─── Sincronización con Amazon SP-API ────────────────────────────────────────
// Este es el corazón del programa. Descarga datos de Amazon y los guarda en BD.
// Se ejecuta automáticamente cada noche (configurado en server.js con cron).
// También se puede ejecutar manualmente: node src/sync.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  fetchOrders, fetchOrderItems, aggregateOrdersByMonthAndAsin
} = require('./orders');

const {
  getProducts, upsertMonthlySales, logSync, getLastSync, getAvailableMonths
} = require('./db');

// ─── Sync principal ───────────────────────────────────────────────────────────
async function syncOrders(daysBack = null) {
  const start = Date.now();
  console.log('\n══════════════════════════════════════════════');
  console.log(' SINCRONIZACIÓN AMAZON SP-API');
  console.log('══════════════════════════════════════════════\n');

  try {
    // Calcular rango de fechas
    const endDate   = new Date();
    const startDate = new Date();

    if (daysBack) {
      startDate.setDate(startDate.getDate() - daysBack);
    } else {
      // Por defecto: desde el primer día del mes anterior
      startDate.setDate(1);
      startDate.setMonth(startDate.getMonth() - 1);
    }

    console.log(`[Sync] Período: ${startDate.toISOString().slice(0,10)} → ${endDate.toISOString().slice(0,10)}`);

    // 1. Traer productos de la BD
    const products = getProducts();
    if (products.length === 0) {
      console.log('[Sync] ⚠️  No hay productos en la BD. Añade productos primero desde el dashboard.');
      return { ok: false, error: 'No hay productos en la BD' };
    }

    const asinMap = Object.fromEntries(products.map(p => [p.asin, p]));
    console.log(`[Sync] Productos: ${products.map(p => p.asin).join(', ')}`);

    // 2. Descargar órdenes de Amazon
    const orders = await fetchOrders(startDate, endDate);
    console.log(`[Sync] ✓ ${orders.length} órdenes descargadas`);

    if (orders.length === 0) {
      logSync('orders', 'ok', 'Sin órdenes en el período', 0);
      return { ok: true, orders: 0 };
    }

    // 3. Descargar items de cada orden (en lotes para no saturar la API)
    console.log('[Sync] Descargando items de órdenes...');
    const orderItemsMap = {};
    const BATCH_SIZE = 10;

    for (let i = 0; i < orders.length; i += BATCH_SIZE) {
      const batch = orders.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (order) => {
        try {
          const items = await fetchOrderItems(order.AmazonOrderId);
          orderItemsMap[order.AmazonOrderId] = items;
        } catch (err) {
          console.warn(`[Sync] No se pudieron obtener items de ${order.AmazonOrderId}`);
        }
      }));

      const progress = Math.round(((i + BATCH_SIZE) / orders.length) * 100);
      process.stdout.write(`\r[Sync] Items: ${Math.min(progress, 100)}% completado`);
    }
    console.log('\n[Sync] ✓ Items descargados');

    // 4. Agregar datos por mes y ASIN
    const aggregated = aggregateOrdersByMonthAndAsin(orders, orderItemsMap);

    // 5. Guardar en BD
    let savedRecords = 0;
    for (const [month, asins] of Object.entries(aggregated)) {
      for (const [asin, data] of Object.entries(asins)) {
        const product = asinMap[asin];
        if (!product) continue; // ASIN no en nuestra BD, ignorar

        upsertMonthlySales({
          product_id:     product.id,
          month,
          units_organic:  data.units,    // SP-API no distingue ads/orgánico en órdenes
          units_returned: data.returns,
          revenue:        data.revenue,
          storage_fee:    0,             // Se actualiza manualmente o via CSV
        });
        savedRecords++;
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[Sync] ✅ Sincronización completada en ${elapsed}s`);
    console.log(`[Sync] ✅ ${savedRecords} registros guardados`);
    console.log(`[Sync] ✅ Meses procesados: ${Object.keys(aggregated).join(', ')}`);

    logSync('orders', 'ok', `${orders.length} órdenes procesadas`, savedRecords);

    return { ok: true, orders: orders.length, records: savedRecords };

  } catch (err) {
    console.error('\n[Sync] ❌ Error:', err.message);
    if (err.response) {
      console.error('[Sync] Respuesta Amazon:', JSON.stringify(err.response.data, null, 2));
    }
    logSync('orders', 'error', err.message, 0);
    return { ok: false, error: err.message };
  }
}

// ─── Importar CSV de Sponsored Products ──────────────────────────────────────
// El CSV de Sponsored Products se descarga desde Seller Central → Advertising
// Formato esperado: el informe estándar de términos de campaña

const { parseTSV } = require('./reports');
const { upsertMonthlyAds } = require('./db');

async function importSponsoredProductsCSV(csvContent, month) {
  console.log(`[Import] Importando Sponsored Products CSV para ${month}...`);

  try {
    // El CSV puede ser TSV (tabs) o CSV (comas)
    const isTSV = csvContent.includes('\t');
    let rows;

    if (isTSV) {
      rows = parseTSV(csvContent);
    } else {
      // Parsear CSV básico
      const lines = csvContent.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      rows = lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
        return Object.fromEntries(headers.map((h, i) => [h, values[i] || '']));
      });
    }

    const products = getProducts();
    const asinMap  = Object.fromEntries(products.map(p => [p.asin, p]));

    // Agregar por ASIN
    const byAsin = {};
    for (const row of rows) {
      // Intentar detectar el ASIN en varias columnas posibles
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

    console.log(`[Import] ✅ ${saved} productos actualizados para ${month}`);
    logSync('ads_csv', 'ok', `CSV importado para ${month}`, saved);

    return { ok: true, saved, rows: rows.length };

  } catch (err) {
    console.error('[Import] ❌ Error:', err.message);
    logSync('ads_csv', 'error', err.message, 0);
    return { ok: false, error: err.message };
  }
}

// ─── Punto de entrada si se ejecuta directamente ──────────────────────────────
if (require.main === module) {
  const days = parseInt(process.env.SYNC_DAYS_BACK) || 90;
  syncOrders(days)
    .then(result => {
      console.log('\nResultado:', JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch(err => {
      console.error('Error fatal:', err);
      process.exit(1);
    });
}

module.exports = { syncOrders, importSponsoredProductsCSV };
