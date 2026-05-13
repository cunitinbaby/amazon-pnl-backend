// ─── Amazon Reports API ───────────────────────────────────────────────────────
// Genera y descarga el reporte "Sales and Traffic by ASIN" mensualmente.
// Este reporte da: unidades vendidas, revenue, sessions, conversion rate por ASIN.

const axios = require('axios');
const { getHeaders } = require('./auth');

const BASE  = process.env.AMAZON_ENDPOINT;
const MKT   = process.env.AMAZON_MARKETPLACE_ID;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Solicita la generación de un reporte
async function requestReport(reportType, startDate, endDate) {
  const headers = await getHeaders();

  const body = {
    reportType,
    marketplaceIds: [MKT],
    dataStartTime:  startDate.toISOString(),
    dataEndTime:    endDate.toISOString(),
  };

  const res = await axios.post(`${BASE}/reports/2021-06-30/reports`, body, { headers });
  return res.data.reportId;
}

// Espera a que el reporte esté listo (puede tardar minutos)
async function waitForReport(reportId, maxWaitMs = 5 * 60 * 1000) {
  const headers  = await getHeaders();
  const start    = Date.now();
  let   status   = 'IN_QUEUE';

  console.log(`[Reports] Esperando reporte ${reportId}...`);

  while (!['DONE', 'CANCELLED', 'FATAL'].includes(status)) {
    if (Date.now() - start > maxWaitMs) throw new Error('Timeout esperando reporte');
    await sleep(15000); // Esperar 15s entre checks

    const res = await axios.get(`${BASE}/reports/2021-06-30/reports/${reportId}`, { headers });
    status = res.data.processingStatus;
    console.log(`[Reports] Estado: ${status}`);

    if (status === 'DONE') return res.data.reportDocumentId;
    if (['CANCELLED', 'FATAL'].includes(status)) throw new Error(`Reporte fallido: ${status}`);
  }
}

// Descarga el documento del reporte
async function downloadReport(documentId) {
  const headers = await getHeaders();

  // Primero obtenemos la URL de descarga
  const res = await axios.get(`${BASE}/reports/2021-06-30/documents/${documentId}`, { headers });
  const url = res.data.url;

  // Descargamos el contenido (puede estar comprimido)
  const download = await axios.get(url, { responseType: 'text' });
  return download.data;
}

// Parsea un TSV (tab-separated) de Amazon
function parseTSV(content) {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split('\t');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]?.trim() || '']));
  });
}

// Genera y descarga el reporte de ventas y tráfico por ASIN
async function getSalesAndTrafficReport(startDate, endDate) {
  try {
    console.log('[Reports] Solicitando Sales & Traffic Report...');
    const reportId   = await requestReport('GET_SALES_AND_TRAFFIC_REPORT', startDate, endDate);
    const documentId = await waitForReport(reportId);
    const content    = await downloadReport(documentId);
    const rows       = parseTSV(content);

    console.log(`[Reports] ${rows.length} filas descargadas`);
    return rows;
  } catch (err) {
    console.error('[Reports] Error:', err.message);
    return [];
  }
}

module.exports = { getSalesAndTrafficReport, parseTSV };
