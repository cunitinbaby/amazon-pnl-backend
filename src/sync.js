// ─── Sincronización Amazon SP-API ────────────────────────────────────────────
try { require('dotenv').config(); } catch (e) {}

const { fetchOrders, fetchOrderItems, aggregateOrdersByMonthAndAsin } = require('./orders');
const { getProducts, upsertMonthlySales, upsertMonthlyAds } = require('./db');
const { parseTSV } = require('./reports');

async function syncOrders(daysBack = 60, log = console.log) {
  const start = Date.now();

  // Verificar credenciales
  if (!process.env.AMAZON_CLIENT_ID || !process.env.AMAZON_REFRESH_TOKEN) {
    log('❌ ERROR: Faltan credenciales de Amazon (AMAZON_CLIENT_ID o AMAZON_REFRESH_TOKEN)');
    return { ok: false, error: 'Faltan credenciales de Amazon' };
  }

  log(`📅 Período: últimos ${daysBack} días`);

  const endDate   = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  log(`📅 Desde: ${startDate.toISOString().slice(0,10)} → ${endDate.toISOString().slice(0,10)}`);

  const products = getProducts();
  if (products.length === 0) {
    log('❌ No hay productos en la base de datos');
    return { ok: false, error: 'No hay productos en la BD' };
  }

  const asinMap = Object.fromEntries(products.map(p => [p.asin, p]));
  log(`📦 Productos: ${products.map(p => p.asin).join(', ')}`);

  try {
    // 1. Descargar órdenes
    log('📥 Descargando órdenes de Amazon...');
    const orders = await fetchOrders(startDate, endDate, log);
    log(`📥 ${orders.length} órdenes descargadas`);

    if (orders.length === 0) {
      log('ℹ️ Sin órdenes en el período — puede ser normal si no hubo ventas');
      return { ok: true, orders: 0, records: 0, message: 'Sin órdenes en el período' };
    }

    // 2. Descargar items por lotes
    log(`📥 Descargando items de ${orders.length} órdenes...`);
    const orderItemsMap = {};
    const BATCH = 3;

    for (let i = 0; i < orders.length; i += BATCH) {
      const batch = orders.slice(i, i + BATCH);
      await Promise.all(batch.map(async (order) => {
        try {
          const items = await fetchOrderItems(order.AmazonOrderId);
          orderItemsMap[order.AmazonOrderId] = items;
        } catch (err) {
          log(`⚠️ Items no disponibles para ${order.AmazonOrderId}: ${err.message}`);
        }
      }));

      if (i % 30 === 0 && i > 0) {
        log(`📥 Progreso: ${Math.min(i+BATCH, orders.length)}/${orders.length}`);
      }
    }

    // 3. Agregar por mes y ASIN
    const aggregated = aggregateOrdersByMonthAndAsin(orders, orderItemsMap);
    log(`📊 Meses con datos: ${Object.keys(aggregated).join(', ') || 'ninguno'}`);

    // 4. Guardar en BD
    let savedRecords = 0;
    for (const [month, asins] of Object.entries(aggregated)) {
      for (const [asin, data] of Object.entries(asins)) {
        const product = asinMap[asin];
        if (!product) {
          log(`⚠️ ASIN ${asin} no encontrado en BD, ignorando`);
          continue;
        }
        upsertMonthlySales({
          product_id:     product.id,
          month,
          units_organic:  data.units,
          units_returned: data.returns,
          revenue:        data.revenue,
          storage_fee:    0,
        });
        log(`✅ Guardado: ${product.name} — ${month} — ${data.units} uds`);
        savedRecords++;
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`✅ Sincronización completada en ${elapsed}s — ${savedRecords} registros guardados`);

    return { ok: true, orders: orders.length, records: savedRecords };

  } catch (err) {
    log(`❌ Error en sincronización: ${err.message}`);

    // Mostrar respuesta de Amazon si existe
    if (err.response) {
      const body = JSON.stringify(err.response.data || {});
      log(`❌ Respuesta Amazon: ${err.response.status} — ${body.slice(0, 200)}`);
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
      log(`✅ PPC actualizado: ${product.name} — Gasto: €${data.ppc_spend.toFixed(2)}`);
      saved++;
    }

    log(`✅ CSV importado: ${saved} productos actualizados para ${month}`);
    return { ok: true, saved, rows: rows.length };

  } catch (err) {
    log(`❌ Error importando CSV: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

if (require.main === module) {
  syncOrders(parseInt(process.env.SYNC_DAYS_BACK)||60, console.log)
    .then(r => { console.log('Resultado:', r); process.exit(r.ok?0:1); })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { syncOrders, importSponsoredProductsCSV };
