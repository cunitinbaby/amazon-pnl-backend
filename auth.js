// ─── Amazon LWA Auth ──────────────────────────────────────────────────────────
// Gestiona el Access Token automáticamente.
// El Refresh Token es permanente; el Access Token dura 1 hora y se renueva solo.

const axios = require('axios');

let _accessToken = null;
let _tokenExpiry = null;

async function getAccessToken() {
  // Si el token sigue vigente (con 60s de margen), lo reutilizamos
  if (_accessToken && _tokenExpiry && Date.now() < _tokenExpiry) {
    return _accessToken;
  }

  console.log('[Auth] Renovando Access Token...');

  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     process.env.AMAZON_CLIENT_ID,
    client_secret: process.env.AMAZON_CLIENT_SECRET,
    refresh_token: process.env.AMAZON_REFRESH_TOKEN,
  });

  const response = await axios.post('https://api.amazon.com/auth/o2/token', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  _accessToken = response.data.access_token;
  _tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

  console.log('[Auth] Token renovado, válido por 1 hora');
  return _accessToken;
}

// Cabeceras estándar para todas las llamadas a SP-API
async function getHeaders() {
  const token = await getAccessToken();
  return {
    'x-amz-access-token': token,
    'Content-Type': 'application/json',
  };
}

module.exports = { getAccessToken, getHeaders };
