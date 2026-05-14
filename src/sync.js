// ─── Sincronización Amazon SP-API ────────────────────────────────────────────
try { require('dotenv').config(); } catch (e) {}

const { fetchOrders, fetchOrderItems, aggregateOrdersByMonthAndAsin } = require('./orders');
const { getProducts, upsertMonthlySales, getMonthlySales } = require('./db');
const { parseTSV } = require('./reports');

async function syncOrders(daysBack = 60, log = console.log) {
  const start = Date.now();

  if (!process.env.AMAZON_CLIENT_ID || !process.env.AMAZON_REFRESH_TOKEN) {
    log('❌ ERROR: Faltan credenciales de Amazon');
    return { ok: false, error: 'Faltan credenciales de Amazon' };
  }

  log(`📅 Período: últimos ${daysBack} días`);

  const endDate   = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  const products = getProducts();
  if (products.length === 0) {
    log('❌ No hay productos en la base de datos');
    return { ok: false, error: 'No hay productos en la BD' };
  }

  const asinMap = Object.fromEntries(products.map(p => [p.asin, p]));
  log(`📦 Productos: ${products.map(p => p.asin).join(', ')}`);

  try {
    log('📥 Descargando órdenes de Amazon...');
    const orders = await fetchOrders(startDate, endDate, log);
    log(`📥 ${orders.length} órdenes totales descargadas`);

    if (orders.length === 0) {
      log('ℹ️ Sin órdenes en el período');
      return { ok: true, orders: 0, records: 0 };
    }

    // Descargar items de forma secuencial
    log(`📥 Descargando items...`);
    const orderItemsMap = {};

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const items = await fetchOrderItems(order.AmazonOrderId, log);
      orderItemsMap[order.AmazonOrderId] = items;

      if ((i + 1) % 10 === 0) {
        log(`📥 Items: ${i + 1}/${orders.length}`);
      }
    }

    const aggregated = aggregateOrdersByMonthAndAsin(orders, orderItemsMap);
    log(`📊 Meses: ${Object.keys(aggregated).join(', ') || 'ninguno'}`);

    // Guardar en BD — SIN sobreescribir datos de PPC introducidos manualmente
    let savedRecords = 0;
    for (const [month, asins] of Object.entries(aggregated)) {
      for (const [asin, data] of Object.entries(asins)) {
        const product = asinMap[asin];
        if (!product) continue;

        // Leer datos existentes para preservar storage_fee
        const existing = getMonthlySales(product.id, month) || {};

        upsertMonthlySales({
          product_id:     product.id,
          month,
          units_organic:  data.units,      // Total unidades vendidas (ads + orgánicas)
          units_returned: data.returns,    // Devoluciones/cancelaciones
          revenue:        data.revenue,
          storage_fee:    existing.storage_fee || 0,  // Preservar storage fee manual
        });

        log(`✅ ${product.name} — ${month} — ${data.units} uds vendidas, ${data.returns} devueltas`);
        savedRecords++;
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`✅ Completado en ${elapsed}s — ${savedRecords} registros`);

    return { ok: true, orders: orders.length, records: savedRecords };

  } catch (err) {
    log(`❌ Error: ${err.message}`);
    if (err.response) {
      log(`❌ Amazon: ${err.response.status} — ${JSON.stringify(err.response.data||{}).slice(0,200)}`);
    }
    return { ok: false, error: err.message };
  }
}

async function importSponsoredProductsCSV(csvContent, month, log = console.log) {
  log(`📥 Importando CSV Sponsored Products para ${month}...`);

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

    const { getProducts, upsertMonthlyAds } = require('./db');
    const products = getProducts();
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
      upsertMonthlyAds({ product_id: product.id, month, ...data });
      log(`✅ PPC: ${product.name} — €${data.ppc_spend.toFixed(2)} gasto, ${data.units_ads} uds ads`);
      saved++;
    }

    log(`✅ CSV importado: ${saved} productos para ${month}`);
    return { ok: true, saved, rows: rows.length };

  } catch (err) {
    log(`❌ Error CSV: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

if (require.main === module) {
  syncOrders(parseInt(process.env.SYNC_DAYS_BACK)||60, console.log)
    .then(r => { console.log('Resultado:', r); process.exit(r.ok?0:1); })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { syncOrders, importSponsoredProductsCSV };
