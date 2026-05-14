// ─── Órdenes Amazon SP-API ────────────────────────────────────────────────────
const axios = require('axios');
const { getAccessToken } = require('./auth');

const BASE = process.env.AMAZON_ENDPOINT;
const MKT  = process.env.AMAZON_MARKETPLACE_ID;

async function fetchOrders(startDate, endDate, log = console.log) {
  try {
    const headers = await getAccessToken();
    const orders = [];
    let nextToken = null;

    while (true) {
      const params = {
        CreatedAfter: startDate.toISOString(),
        CreatedBefore: endDate.toISOString(),
        OrderStatuses: ['Pending', 'Unshipped', 'PartiallyShipped', 'Shipped', 'Canceled', 'Unfulfillable'],
        MaxResultsPerPage: 50,
      };
      if (nextToken) params.NextToken = nextToken;

      try {
        const res = await axios.get(`${BASE}/orders/v0/orders`, { headers, params });
        if (res.data.payload?.Orders) {
          orders.push(...res.data.payload.Orders);
        }
        nextToken = res.data.payload?.NextToken;
        if (!nextToken) break;
      } catch (err) {
        if (err.response?.status === 429) {
          log('⏳ Rate limit — esperando 5s...');
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        throw err;
      }
    }

    return orders;
  } catch (err) {
    log(`❌ fetchOrders: ${err.message}`);
    throw err;
  }
}

async function fetchOrderItems(orderId, log = console.log) {
  try {
    const headers = await getAccessToken();
    const res = await axios.get(`${BASE}/orders/v0/orders/${orderId}/orderitems`, { headers });
    return res.data.payload?.OrderItems || [];
  } catch (err) {
    log(`⚠️ Items ${orderId}: ${err.message}`);
    return [];
  }
}

function aggregateOrdersByDateAndAsin(orders, orderItemsMap) {
  const byDateAsin = {}; // "2026-05-14::ASIN" -> {units, returns, revenue}

  for (const order of orders) {
    const date = order.PurchaseDate.slice(0, 10); // YYYY-MM-DD
    const items = orderItemsMap[order.AmazonOrderId] || [];
    const isReturned = order.OrderStatus === 'Canceled';

    for (const item of items) {
      const asin = item.ASIN;
      if (!asin) continue;

      const key = `${date}::${asin}`;
      if (!byDateAsin[key]) {
        byDateAsin[key] = { units: 0, returns: 0, revenue: 0, date, asin };
      }

      const qty = item.QuantityOrdered - item.QuantityShipped;
      if (isReturned) {
        byDateAsin[key].returns += qty;
      } else {
        byDateAsin[key].units += qty;
        byDateAsin[key].revenue += (item.ItemPrice?.Amount || 0) * qty;
      }
    }
  }

  return byDateAsin;
}

module.exports = { fetchOrders, fetchOrderItems, aggregateOrdersByDateAndAsin };
