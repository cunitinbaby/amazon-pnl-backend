// ─── Amazon Orders API ────────────────────────────────────────────────────────
const axios = require('axios');
const { getHeaders } = require('./auth');

const BASE = process.env.AMAZON_ENDPOINT;
const MKT  = process.env.AMAZON_MARKETPLACE_ID;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Trae órdenes entre dos fechas
async function fetchOrders(startDate, endDate, log = console.log) {
  const headers = await getHeaders();
  const orders  = [];
  let nextToken = null;
  let page      = 1;

  // Amazon requiere que CreatedBefore tenga al menos 2 minutos de retraso
  // Usamos 5 minutos para mayor seguridad
  const safeEndDate = new Date(endDate.getTime() - 5 * 60 * 1000);
  log(`📥 Rango: ${startDate.toISOString().slice(0,10)} → ${safeEndDate.toISOString().slice(0,16)}`);

  do {
    const params = {
      MarketplaceIds: MKT,
      CreatedAfter:   startDate.toISOString(),
      CreatedBefore:  safeEndDate.toISOString(),
    };
    if (nextToken) params.NextToken = nextToken;

    const res = await axios.get(`${BASE}/orders/v0/orders`, { headers, params });
    const payload = res.data.payload;

    if (payload.Orders) orders.push(...payload.Orders);
    nextToken = payload.NextToken || null;

    log(`📄 Página ${page}: ${payload.Orders?.length || 0} órdenes (total: ${orders.length})`);
    page++;

    if (nextToken) await sleep(1100);

  } while (nextToken);

  return orders;
}

// Trae los items de una orden concreta
async function fetchOrderItems(orderId) {
  const headers = await getHeaders();
  await sleep(300);
  const res = await axios.get(`${BASE}/orders/v0/orders/${orderId}/orderItems`, { headers });
  return res.data.payload.OrderItems || [];
}

// Procesa y agrupa órdenes por mes y ASIN
function aggregateOrdersByMonthAndAsin(orders, orderItemsMap) {
  const result = {};

  for (const order of orders) {
    if (!['Shipped', 'Unshipped', 'PartiallyShipped'].includes(order.OrderStatus)) continue;

    const date  = new Date(order.PurchaseDate);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const items = orderItemsMap[order.AmazonOrderId] || [];

    for (const item of items) {
      const asin = item.ASIN;
      if (!result[month])       result[month] = {};
      if (!result[month][asin]) result[month][asin] = { units: 0, revenue: 0, returns: 0 };

      const qty   = Number(item.QuantityOrdered || 0);
      const price = Number(item.ItemPrice?.Amount || 0);

      result[month][asin].units   += qty;
      result[month][asin].revenue += price;
    }
  }

  return result;
}

module.exports = { fetchOrders, fetchOrderItems, aggregateOrdersByMonthAndAsin };
