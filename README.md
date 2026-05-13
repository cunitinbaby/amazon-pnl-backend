# Panel P&L Amazon FBA — Backend

Servidor Node.js que se conecta automáticamente a Amazon SP-API cada noche,
descarga tus datos de ventas y los sirve al dashboard web.

---

## Requisitos

- Node.js 18 o superior → descargar en [nodejs.org](https://nodejs.org)
- Cuenta de Amazon Seller Central con SP-API aprobado ✅ (ya lo tienes)

---

## Instalación (una sola vez)

```bash
# 1. Entra a la carpeta del proyecto
cd amazon-pnl-backend

# 2. Instala dependencias
npm install

# 3. El archivo .env ya está configurado con tus credenciales
#    (no necesitas tocarlo)

# 4. Arranca el servidor
npm start
```

El servidor arranca en `http://localhost:3001`.

---

## Comandos disponibles

```bash
# Arrancar servidor (con sincronización automática)
npm start

# Sincronización manual ahora mismo
npm run sync

# Desarrollo con auto-reload
npm run dev
```

---

## Endpoints de la API

Todos los endpoints necesitan el header: `x-api-key: mi_clave_secreta_2026`

| Método | URL | Descripción |
|--------|-----|-------------|
| GET | `/health` | Estado del servidor |
| GET | `/api/months` | Meses con datos |
| GET | `/api/products` | Tus productos |
| GET | `/api/dashboard/:month` | P&L completo de un mes |
| POST | `/api/sync` | Sincronizar con Amazon ahora |
| POST | `/api/import-ads-csv` | Importar CSV de Sponsored Products |
| GET | `/api/sync/status` | Estado última sincronización |

---

## Cómo funciona la sincronización

### Ventas (automático)
Cada noche a las 2:00am el servidor:
1. Se conecta a Amazon SP-API con tus credenciales
2. Descarga todas las órdenes del último mes
3. Las guarda en la base de datos local (`data/pnl.db`)
4. El dashboard lee los datos actualizados automáticamente

### Sponsored Products (manual, una vez al mes)
Amazon no permite acceder a datos de Sponsored Products por SP-API sin aprobación adicional.
Por eso, una vez al mes:
1. En Seller Central → Advertising → Descargas → Informe de términos de campaña
2. En el dashboard, ve a ⊞ Mensual → Importar CSV
3. El programa procesa el CSV y actualiza los datos de ads

---

## Publicar en Railway (para acceder desde el móvil)

Railway es gratuito y sirve tu backend 24/7.

```bash
# 1. Instalar Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Publicar
railway init
railway up

# 4. Añadir variables de entorno en el panel de Railway
#    (copia el contenido de tu .env)
```

Te dará una URL tipo `https://amazon-pnl-production.up.railway.app`
que puedes usar desde el móvil o cualquier dispositivo.

---

## Estructura del proyecto

```
amazon-pnl-backend/
├── .env                 ← Tus credenciales (no compartir)
├── package.json
├── src/
│   ├── server.js        ← Servidor principal + cron
│   ├── sync.js          ← Lógica de sincronización
│   ├── auth.js          ← Autenticación Amazon LWA
│   ├── orders.js        ← Descarga de órdenes
│   ├── reports.js       ← Reportes Amazon
│   └── db.js            ← Base de datos SQLite
└── data/
    └── pnl.db           ← Base de datos (se crea automáticamente)
```

---

## Solución de problemas

**Error: "No autorizado"**
→ Asegúrate de incluir el header `x-api-key` en las peticiones

**Error: "Invalid token"**
→ El Refresh Token ha caducado. Genera uno nuevo en Seller Central

**Error: "Rate limit"**
→ Amazon limita las llamadas. El programa ya gestiona esto automáticamente,
  pero si haces demasiadas sincronizaciones manuales puede aparecer

**El servidor no arranca**
→ Ejecuta `npm install` primero para instalar las dependencias
