// =====================================================================
// MAGIC TRAVELERS - Backend ENIX (Render.com)
// Endpoints: /test-connection, /search, /hotel-data, /hotels-list
// =====================================================================

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// =====================================================================
// CORS — permite que el frontend (Vercel/DonWeb) consuma este backend
// =====================================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =====================================================================
// CONFIGURACIÓN ENIX
// =====================================================================
const ENIX_CONFIG = {
  endpoint: process.env.ENIX_ENDPOINT || 'http://integrate.dev.enix.travel/Service_Parks.asmx',
  username: process.env.ENIX_USERNAME || 'testnewXML',
  password: process.env.ENIX_PASSWORD || 'testnewXML2023$',
  namespace: 'http://tempuri.org/',
  margin: parseFloat(process.env.MAGIC_MARGIN || '1.10'), // 10% de margen Magic Travelers
};

// =====================================================================
// HELPERS
// =====================================================================

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSoapEnvelope(methodName, bodyContent = '') {
  const body = bodyContent
    ? `<${methodName} xmlns="${ENIX_CONFIG.namespace}">${bodyContent}</${methodName}>`
    : `<${methodName} xmlns="${ENIX_CONFIG.namespace}" />`;

  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <AuthHeader xmlns="${ENIX_CONFIG.namespace}">
      <Username>${escapeXml(ENIX_CONFIG.username)}</Username>
      <Password>${escapeXml(ENIX_CONFIG.password)}</Password>
    </AuthHeader>
  </soap:Header>
  <soap:Body>
    ${body}
  </soap:Body>
</soap:Envelope>`;
}

async function callEnix(methodName, bodyContent = '') {
  const soapBody = buildSoapEnvelope(methodName, bodyContent);

  try {
    const response = await axios.post(
      ENIX_CONFIG.endpoint,
      soapBody,
      {
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': `"${ENIX_CONFIG.namespace}${methodName}"`,
        },
        timeout: 60000, // 60s para búsquedas grandes
      }
    );
    return { success: true, status: response.status, data: response.data };
  } catch (error) {
    return {
      success: false,
      status: error.response?.status || 500,
      error: error.message,
      details: error.response?.data || null,
    };
  }
}

// =====================================================================
// PARSER XML → JSON (sin librerías externas)
// Extrae los datos clave para no enviar XML pesado al frontend
// =====================================================================

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const matches = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

function extractFirst(xml, tag) {
  const arr = extractTag(xml, tag);
  return arr.length > 0 ? arr[0] : null;
}

function parseHotelList(xml) {
  const hotels = extractTag(xml, 'Hotel');
  return hotels.map(h => ({
    hotelId: extractFirst(h, 'hotelid'),
    name: (extractFirst(h, 'name') || '').trim(),
    address: (extractFirst(h, 'address') || '').trim(),
    parkType: extractFirst(h, 'ParkType'),
    latitude: parseFloat(extractFirst(h, 'latitude')) || null,
    longitude: parseFloat(extractFirst(h, 'longitude')) || null,
    zipcode: extractFirst(h, 'zipcode'),
    phone: (extractFirst(h, 'phone') || '').trim(),
    expediaCode: extractFirst(h, 'expediaCode'),
  }));
}

function parseSearchResults(xml) {
  // Devuelve hoteles con sus opciones de habitación + precios
  const hotels = extractTag(xml, 'Hotel');
  return hotels.map(h => {
    const options = extractTag(h, 'Option').map(opt => {
      const netPrice = parseFloat(extractFirst(opt, 'total')) || 0;
      const finalPrice = Math.round(netPrice * ENIX_CONFIG.margin * 100) / 100;

      return {
        optionId: extractFirst(opt, 'optionid'),
        roomType: (extractFirst(opt, 'roomtype') || '').trim(),
        roomTypeId: extractFirst(opt, 'roomtypeid'),
        mealPlan: (extractFirst(opt, 'mealplan') || '').trim(),
        netPrice: netPrice,           // Precio neto ENIX (para uso interno)
        finalPrice: finalPrice,        // Precio con margen +10% (mostrar al cliente)
        currency: extractFirst(opt, 'currency') || 'USD',
        cancellation: (extractFirst(opt, 'cancellationpolicy') || '').trim(),
      };
    });

    return {
      hotelId: extractFirst(h, 'hotelid'),
      name: (extractFirst(h, 'name') || '').trim(),
      parkType: extractFirst(h, 'ParkType'),
      options: options,
      minPrice: options.length > 0 ? Math.min(...options.map(o => o.finalPrice)) : null,
    };
  });
}

// =====================================================================
// ENDPOINTS PÚBLICOS DEL BACKEND
// =====================================================================

// Healthcheck
app.get('/', (req, res) => {
  res.json({
    service: 'Magic Travelers ENIX Backend',
    status: 'OK',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET  /                  - este healthcheck',
      'GET  /api/test-connection - lista de hoteles (test ENIX)',
      'GET  /api/hotels-list   - lista de hoteles parseada a JSON',
      'POST /api/search        - buscar hoteles con fechas y huéspedes',
      'GET  /api/hotel-data/:id - detalle de un hotel específico',
    ],
  });
});

// Test de conexión (XML crudo, ya andaba)
app.get('/api/test-connection', async (req, res) => {
  const result = await callEnix('GetHotelMaster');
  res.json(result);
});

// Lista de hoteles parseada a JSON (más útil para el frontend)
app.get('/api/hotels-list', async (req, res) => {
  const result = await callEnix('GetHotelMaster');
  if (!result.success) return res.status(500).json(result);

  const hotels = parseHotelList(result.data);
  res.json({
    success: true,
    count: hotels.length,
    hotels: hotels,
  });
});

// Búsqueda con fechas y huéspedes
// POST /api/search
// Body: { type: "Disney|Universal|All", arrival: "2026-07-10", departure: "2026-07-15", adults: 2, children: 1, childAges: [10] }
app.post('/api/search', async (req, res) => {
  const {
    type = 'All',
    arrival,
    departure,
    adults = 2,
    children = 0,
    childAges = [],
  } = req.body;

  // Validaciones básicas
  if (!arrival || !departure) {
    return res.status(400).json({
      success: false,
      error: 'arrival y departure son requeridos (formato YYYY-MM-DD)',
    });
  }
  if (!['Disney', 'Universal', 'All'].includes(type)) {
    return res.status(400).json({
      success: false,
      error: 'type debe ser "Disney", "Universal" o "All"',
    });
  }

  // Armar el body XML interno
  const childAgesXml = childAges.length > 0
    ? `<childage>${childAges.map(age => `<int>${parseInt(age)}</int>`).join('')}</childage>`
    : '';

  const bodyXml = `
      <type>${type}</type>
      <arrival>${arrival}</arrival>
      <departure>${departure}</departure>
      <paxlist>
        <adults>${parseInt(adults)}</adults>
        <child>${parseInt(children)}</child>
        ${childAgesXml}
      </paxlist>
  `.trim();

  const result = await callEnix('SearchHotel', bodyXml);
  if (!result.success) return res.status(500).json(result);

  // Parsear resultado a JSON limpio
  const hotels = parseSearchResults(result.data);
  res.json({
    success: true,
    query: { type, arrival, departure, adults, children, childAges },
    count: hotels.length,
    hotels: hotels,
    rawXml: result.data, // para debug, sacar en producción
  });
});

// Detalle de un hotel específico
// GET /api/hotel-data/:hotelId
app.get('/api/hotel-data/:hotelId', async (req, res) => {
  const hotelId = parseInt(req.params.hotelId);
  if (!hotelId) return res.status(400).json({ success: false, error: 'hotelId inválido' });

  const bodyXml = `<hotelid>${hotelId}</hotelid>`;
  const result = await callEnix('GetHotelData', bodyXml);

  res.json(result);
});

// =====================================================================
// ARRANQUE
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Magic Travelers backend listening on port ${PORT}`);
  console.log(`ENIX endpoint: ${ENIX_CONFIG.endpoint}`);
  console.log(`Margin: ${ENIX_CONFIG.margin}`);
});
