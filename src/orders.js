// ─── Amazon Orders API ────────────────────────────────────────────────────────
const axios = require('axios');
const { getHeaders } = require('./auth');

const BASE  = process.env.AMAZON_ENDPOINT;
const MKT   = process.env.AMAZON_MARKETPLACE_ID;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchOrdersWithStatus(startDate, endDate, status, log = console.log) {
  const headers = await getHeaders();
  const orders  = [];
  let nextToken = null;
  let page      = 1;

  const safeEnd = new Date(endDate.getTime() - 5 * 60 * 1000);

  do {
    const params = {
      MarketplaceIds: MKT,
      CreatedAfter:   startDate.toISOString(),
      CreatedBefore:  safeEnd.toISOString(),
      OrderStatuses:  status,
    };
    if (nextToken) params.NextToken = nextToken;

    try {
      const res     = await axios.get(`${BASE}/orders/v0/orders`, { headers, params });
      const payload = res.data.payload;
      if (payload.Orders) orders.push(...payload.Orders);
      nextToken = payload.NextToken || null;
      log(`📄 [${status}] Página ${page}: ${payload.Orders?.length || 0} órdenes`);
      page++;
      await sleep(1100);
    } catch (err) {
      if (err.response?.status === 429) {
        log(`⏳ Rate limit, esperando 10s...`);
        await sleep(10000);
      } else {
        throw err;
      }
    }
  } while (nextToken);

  return orders;
}

async function fetchOrders(startDate, endDate, log = console.log) {
  log(`📥 Rango: ${startDate.toISOString().slice(0,10)} → ${new Date(endDate.getTime() - 5*60*1000).toISOString().slice(0,10)}`);

  // Descargar órdenes enviadas/pendientes Y canceladas (devoluciones)
  const [shipped, canceled] = await Promise.all([
    fetchOrdersWithStatus(startDate, endDate, 'Shipped', log),
    fetchOrdersWithStatus(startDate, endDate, 'Canceled', log),
  ]);

  log(`📥 Enviadas: ${shipped.length} | Canceladas/devueltas: ${canceled.length}`);

  // Marcar las canceladas para identificarlas luego
  canceled.forEach(o => o._isCanceled = true);

  return [...shipped, ...canceled];
}

async function fetchOrderItems(orderId, log = console.log) {
  const headers = await getHeaders();
  await sleep(2100);

  try {
    const res = await axios.get(`${BASE}/orders/v0/orders/${orderId}/orderItems`, { headers });
    return res.data.payload.OrderItems || [];
  } catch (err) {
    if (err.response?.status === 429) {
      log(`⏳ Rate limit items, esperando 5s...`);
      await sleep(5000);
      try {
        const res2 = await axios.get(`${BASE}/orders/v0/orders/${orderId}/orderItems`, { headers });
        return res2.data.payload.OrderItems || [];
      } catch { return []; }
    }
    return [];
  }
}

function aggregateOrdersByMonthAndAsin(orders, orderItemsMap) {
  const result = {};

  for (const order of orders) {
    const isCanceled = order._isCanceled || order.OrderStatus === 'Canceled';
    const date  = new Date(order.PurchaseDate);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const items = orderItemsMap[order.AmazonOrderId] || [];

    for (const item of items) {
      const asin = item.ASIN;
      if (!result[month])       result[month] = {};
      if (!result[month][asin]) result[month][asin] = { units: 0, revenue: 0, returns: 0 };

      const qty = Number(item.QuantityOrdered || 0);
      const price = Number(item.ItemPrice?.Amount || 0);

      if (isCanceled) {
        result[month][asin].returns += qty;
      } else {
        result[month][asin].units   += qty;
        result[month][asin].revenue += price;
      }
    }
  }

  return result;
}

module.exports = { fetchOrders, fetchOrderItems, aggregateOrdersByMonthAndAsin };
