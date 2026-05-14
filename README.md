# Panel P&L Amazon FBA - Backend

Backend Node.js para sincronizar con Amazon SP-API.

## Deploy en Railway

1. Conecta este repositorio a Railway
2. Añade las variables de entorno (en Railway > Variables):
   - `AMAZON_CLIENT_ID`
   - `AMAZON_CLIENT_SECRET`
   - `AMAZON_REFRESH_TOKEN`
   - `AMAZON_MARKETPLACE_ID=A1RKKUPIHCS9HS`
   - `AMAZON_ENDPOINT=https://sellingpartnerapi-eu.amazon.com`
   - `API_SECRET=tu_clave_secreta`
3. Railway despliega automáticamente

## Endpoints

- `GET /health` — Estado del servidor (sin auth)
- `GET /api/dashboard/:month` — P&L de un mes
- `POST /api/sync` — Sincronizar con Amazon

Todas las rutas `/api/*` requieren header `x-api-key: tu_clave_secreta`
