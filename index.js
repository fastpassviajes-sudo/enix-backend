// =====================================================================
// MAGIC TRAVELERS - Backend ENIX + Claude AI v4
// =====================================================================
// CAMBIOS CLAVE vs v3:
//   1. NUEVOS endpoints sobre Service_Parks (donde viven los hoteles Disney/Universal):
//      - SearchHotel             → hoteles + tarifas (búsqueda simple)
//      - SearchHotel_MainRoomResults → hoteles + tarifas + tickets de parque
//      - GetPromoMasterDisney    → promos activas Disney
//   2. Claude ahora tiene DOS tools de búsqueda y elige según el cliente:
//      - buscar_hoteles_simple → cuando el cliente sólo quiere ver opciones
//      - buscar_hoteles_con_tickets → cuando quiere paquete con días de parque
//   3. Service_Hotels.SearchHotelAdvancedV1 queda como endpoint legacy
//      por si más adelante querés ofrecer hoteles "no oficiales" de Orlando.
// =====================================================================
 
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
 
const app = express();
app.use(express.json({ limit: '1mb' }));
 
// ---------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
 
// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------
const ENIX_CONFIG = {
  parksEndpoint: process.env.ENIX_ENDPOINT || 'http://integrate.dev.enix.travel/Service_Parks.asmx',
  hotelsEndpoint: process.env.ENIX_HOTELS_ENDPOINT || 'http://integratedev.fullofdreams.travel/Service_Hotels.asmx',
  username: process.env.ENIX_USERNAME || 'testnewXML',
  password: process.env.ENIX_PASSWORD || 'testnewXML2023$',
  namespace: 'http://tempuri.org/',
  margin: parseFloat(process.env.MAGIC_MARGIN || '1.10'),
  orlandoCityId: parseInt(process.env.ORLANDO_CITY_ID || '729'),
};
 
const MAGIC_CONFIG = {
  whatsappNumber: process.env.MAGIC_WHATSAPP || '5491121882210',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  claudeMaxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS || '2048'),
};
 
const anthropic = new Anthropic();
 
// ---------------------------------------------------------------------
// HELPERS XML
// ---------------------------------------------------------------------
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
 
function extractTagAll(xml, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const matches = [];
  let m;
  while ((m = regex.exec(xml)) !== null) matches.push(m[1]);
  return matches;
}
 
function extractFirst(xml, tag) {
  const arr = extractTagAll(xml, tag);
  return arr.length > 0 ? arr[0] : null;
}
 
// ---------------------------------------------------------------------
// SOAP 1.1 (Service_Parks.asmx)
// IMPORTANTE: Usamos prefijo "tem:" en todos los elementos del namespace
// tempuri.org porque ENIX/SOAP UI lo manda así y algunos servicios
// ASP.NET viejos validan literalmente la sintaxis del prefijo.
// ---------------------------------------------------------------------
function buildSoap11(methodName, bodyContent = '') {
  // Si el body trae contenido, ya viene con tags <type>, <arrival>, etc.
  // Para que respete el namespace tem:, los reescribimos con el prefijo.
  // Pero la forma más simple es declarar el namespace en el method element
  // y dejar el body sin prefijo — el problema NO es el body sino el AuthHeader.
  const body = bodyContent
    ? `<tem:${methodName}>${bodyContent}</tem:${methodName}>`
    : `<tem:${methodName} />`;
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soap:Header>
    <tem:AuthHeader>
      <tem:Username>${escapeXml(ENIX_CONFIG.username)}</tem:Username>
      <tem:Password>${escapeXml(ENIX_CONFIG.password)}</tem:Password>
    </tem:AuthHeader>
  </soap:Header>
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}
 
async function callEnixParks(methodName, bodyContent = '') {
  const soapBody = buildSoap11(methodName, bodyContent);
  try {
    const response = await axios.post(ENIX_CONFIG.parksEndpoint, soapBody, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `"${ENIX_CONFIG.namespace}${methodName}"`,
      },
      timeout: 90000,
    });
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
 
// ---------------------------------------------------------------------
// SOAP 1.2 (Service_Hotels.asmx) - legacy, solo para hoteles no Disney/Universal
// ---------------------------------------------------------------------
function buildSoap12(methodName, bodyContent = '') {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tem="http://tempuri.org/">
  <soap:Header>
    <tem:AuthHeader>
      <tem:Username>${escapeXml(ENIX_CONFIG.username)}</tem:Username>
      <tem:Password>${escapeXml(ENIX_CONFIG.password)}</tem:Password>
    </tem:AuthHeader>
  </soap:Header>
  <soap:Body>
    <tem:${methodName}>
${bodyContent}
    </tem:${methodName}>
  </soap:Body>
</soap:Envelope>`;
}
 
async function callEnixHotels(methodName, bodyContent = '') {
  const soapBody = buildSoap12(methodName, bodyContent);
  try {
    const response = await axios.post(ENIX_CONFIG.hotelsEndpoint, soapBody, {
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="${ENIX_CONFIG.namespace}${methodName}"`,
      },
      timeout: 90000,
    });
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
 
// ---------------------------------------------------------------------
// PARSERS
// ---------------------------------------------------------------------
 
function parseHotelMasterList(xml) {
  const hotels = extractTagAll(xml, 'Hotel');
  return hotels.map(h => ({
    hotelId: extractFirst(h, 'hotelid') || extractFirst(h, 'HotelID') || extractFirst(h, 'Id'),
    name: (extractFirst(h, 'name') || extractFirst(h, 'Name') || '').trim(),
    address: (extractFirst(h, 'address') || extractFirst(h, 'Address') || '').trim(),
    parkType: extractFirst(h, 'ParkType') || extractFirst(h, 'parktype') || null,
    latitude: parseFloat(extractFirst(h, 'latitude') || extractFirst(h, 'Latitude')) || null,
    longitude: parseFloat(extractFirst(h, 'longitude') || extractFirst(h, 'Longitude')) || null,
    zipcode: extractFirst(h, 'zipcode') || extractFirst(h, 'ZipCode'),
    phone: (extractFirst(h, 'phone') || extractFirst(h, 'Phone') || '').trim(),
  })).filter(h => h.hotelId);
}
 
// Parser permisivo para SearchHotel / SearchHotel_MainRoomResults.
// La estructura exacta puede variar; intentamos varios nombres de tag.
function parseSearchHotelResponse(xml) {
  const totalRecords = parseInt(extractFirst(xml, 'TotalRecords') || extractFirst(xml, 'totalrecords') || '0');
  const hotels = extractTagAll(xml, 'Hotel');
 
  if (hotels.length === 0) {
    return { totalRecords, hotels: [] };
  }
 
  const parsedHotels = hotels.map(h => {
    const hotelId = extractFirst(h, 'Id') || extractFirst(h, 'hotelid') || extractFirst(h, 'HotelID');
    const name = (extractFirst(h, 'Name') || extractFirst(h, 'name') || '').trim();
    const parkType = extractFirst(h, 'ParkType') || extractFirst(h, 'parktype') || null;
 
    const rooms = extractTagAll(h, 'Room');
    const parsedRooms = rooms.map(r => {
      const roomType = (extractFirst(r, 'RoomType') || extractFirst(r, 'roomtype') || '').trim();
      const roomTypeId = extractFirst(r, 'RoomTypeID') || extractFirst(r, 'roomtypeID') || extractFirst(r, 'RoomID');
 
      // Las "opciones" pueden venir como <Option>, <RatePlan> o <Rate>
      let optionBlocks = extractTagAll(r, 'Option');
      if (optionBlocks.length === 0) optionBlocks = extractTagAll(r, 'RatePlan');
      if (optionBlocks.length === 0) optionBlocks = extractTagAll(r, 'Rate');
 
      const parsedOptions = optionBlocks.map(opt => {
        const netCandidates = [
          extractFirst(opt, 'NetTotal'),
          extractFirst(opt, 'OptionNightsTotal'),
          extractFirst(opt, 'OptionNightsNetTotal'),
          extractFirst(opt, 'NetPrice'),
          extractFirst(opt, 'Price'),
          extractFirst(opt, 'TotalPrice'),
        ].filter(Boolean);
        const netPrice = parseFloat(netCandidates[0] || '0');
        const finalPrice = Math.round(netPrice * ENIX_CONFIG.margin * 100) / 100;
 
        return {
          optionId: extractFirst(opt, 'OptionID') || extractFirst(opt, 'OptionId') || extractFirst(opt, 'Id'),
          rateplan: extractFirst(opt, 'RatePlan') || extractFirst(opt, 'rateplan'),
          bookParam: extractFirst(opt, 'BookParam'),
          board: (extractFirst(opt, 'Board') || extractFirst(opt, 'board') || '').trim(),
          ticketType: extractFirst(opt, 'TicketType') || extractFirst(opt, 'TicketTypeID') || null,
          ticketName: (extractFirst(opt, 'TicketName') || '').trim(),
          netPrice,
          finalPrice,
          currency: extractFirst(opt, 'Currency') || 'USD',
        };
      });
 
      return { roomType, roomTypeId, options: parsedOptions };
    });
 
    const allPrices = parsedRooms
      .flatMap(r => r.options.map(o => o.finalPrice))
      .filter(p => p > 0);
    const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : null;
 
    return { hotelId, name, parkType, rooms: parsedRooms, minPrice };
  });
 
  const finalTotal = totalRecords || parsedHotels.length;
  return { totalRecords: finalTotal, hotels: parsedHotels };
}
 
function parsePromos(xml) {
  const promos = extractTagAll(xml, 'Promo');
  return promos.map(p => ({
    id: extractFirst(p, 'Id') || extractFirst(p, 'PromoId'),
    name: (extractFirst(p, 'Name') || '').trim(),
    description: (extractFirst(p, 'Description') || '').trim(),
    validFrom: extractFirst(p, 'ValidFrom') || extractFirst(p, 'StartDate'),
    validTo: extractFirst(p, 'ValidTo') || extractFirst(p, 'EndDate'),
    discount: extractFirst(p, 'Discount') || extractFirst(p, 'DiscountPercent'),
  }));
}
 
// ---------------------------------------------------------------------
// CACHE de hoteles Disney/Universal
// ---------------------------------------------------------------------
let hotelsCache = { data: null, timestamp: 0 };
const HOTELS_CACHE_TTL = 60 * 60 * 1000;
 
async function getHotelsList({ force = false } = {}) {
  if (!force && hotelsCache.data && Date.now() - hotelsCache.timestamp < HOTELS_CACHE_TTL) {
    return hotelsCache.data;
  }
 
  // GetHotelMaster en Service_Parks NO requiere parámetros (segun WSDL: <complexType/>).
  const result = await callEnixParks('GetHotelMaster');
  if (!result.success) {
    console.warn('[CACHE] GetHotelMaster falló');
    return hotelsCache.data || null;
  }
 
  const hotels = parseHotelMasterList(result.data);
  if (hotels.length === 0) {
    console.warn('[CACHE] GetHotelMaster devolvió 0 hoteles');
    return hotelsCache.data || null;
  }
 
  hotelsCache = { data: hotels, timestamp: Date.now() };
  console.log(`[CACHE] Refrescado con ${hotels.length} hoteles`);
  return hotels;
}
 
function filterByPark(hotels, parque) {
  if (!parque || parque === 'All') return hotels;
  const target = parque.toLowerCase();
  return hotels.filter(h => {
    if (!h.parkType) return false;
    return h.parkType.toLowerCase().includes(target);
  });
}
 
// ---------------------------------------------------------------------
// NUEVO: SearchHotel sobre Service_Parks (sin tickets)
// ---------------------------------------------------------------------
async function searchHotelSimple({
  type = 'All',
  arrival,
  departure,
  adults = 2,
  children = 0,
  childAges = [],
}) {
  const fmtDate = (d) => (d.includes('T') ? d : `${d}T00:00:00`);
  const childAgesXml = childAges.length > 0
    ? `<childage>${childAges.map(a => `<int>${parseInt(a)}</int>`).join('')}</childage>`
    : '<childage></childage>';
 
  const body = `<type>${type}</type>
<arrival>${fmtDate(arrival)}</arrival>
<departure>${fmtDate(departure)}</departure>
<paxlist>
  <adults>${parseInt(adults)}</adults>
  <child>${parseInt(children)}</child>
  ${childAgesXml}
</paxlist>`;
 
  const result = await callEnixParks('SearchHotel', body);
  if (!result.success) return result;
 
  const parsed = parseSearchHotelResponse(result.data);
  return {
    success: true,
    method: 'SearchHotel',
    ...parsed,
    margin: ENIX_CONFIG.margin,
    note: 'Precios en finalPrice ya incluyen el margen del 10% de Magic Travelers',
  };
}
 
// ---------------------------------------------------------------------
// NUEVO: SearchHotel_MainRoomResults sobre Service_Parks (con tickets)
// ---------------------------------------------------------------------
async function searchHotelWithTickets({
  type = 'All',
  arrival,
  departure,
  adults = 2,
  children = 0,
  childAges = [],
  ticketDays = 4,
}) {
  const fmtDate = (d) => (d.includes('T') ? d : `${d}T00:00:00`);
  const childAgesXml = childAges.length > 0
    ? `<childage>${childAges.map(a => `<int>${parseInt(a)}</int>`).join('')}</childage>`
    : '<childage></childage>';
 
  const body = `<type>${type}</type>
<arrival>${fmtDate(arrival)}</arrival>
<departure>${fmtDate(departure)}</departure>
<paxlist>
  <adults>${parseInt(adults)}</adults>
  <child>${parseInt(children)}</child>
  ${childAgesXml}
</paxlist>
<TicketDays>${parseInt(ticketDays)}</TicketDays>`;
 
  const result = await callEnixParks('SearchHotel_MainRoomResults', body);
  if (!result.success) return result;
 
  const parsed = parseSearchHotelResponse(result.data);
  return {
    success: true,
    method: 'SearchHotel_MainRoomResults',
    ticketDays,
    ...parsed,
    margin: ENIX_CONFIG.margin,
    note: 'Precios incluyen hotel + tickets de parque, con margen 10% Magic Travelers',
  };
}
 
// ---------------------------------------------------------------------
// NUEVO: GetPromoMasterDisney
// ---------------------------------------------------------------------
let promosCache = { data: null, timestamp: 0 };
const PROMOS_CACHE_TTL = 6 * 60 * 60 * 1000;
 
async function getPromosDisney({ force = false } = {}) {
  if (!force && promosCache.data && Date.now() - promosCache.timestamp < PROMOS_CACHE_TTL) {
    return promosCache.data;
  }
  const result = await callEnixParks('GetPromoMasterDisney');
  if (!result.success) return promosCache.data || [];
  const promos = parsePromos(result.data);
  promosCache = { data: promos, timestamp: Date.now() };
  return promos;
}
 
// ---------------------------------------------------------------------
// LEGACY: Service_Hotels.SearchHotelAdvancedV1
// ---------------------------------------------------------------------
async function searchHotelsAdvancedLegacy({
  cityId = ENIX_CONFIG.orlandoCityId,
  arrival, departure,
  adults = 2, children = 0, childAges = [],
  qty = 1, hotelList = [], availableOnly = 1,
}) {
  const fmtDate = (d) => (d.includes('T') ? d : `${d}T00:00:00`);
  const childAgesXml = childAges.length > 0
    ? `         <tem:childage>${childAges.map(a => `<tem:int>${parseInt(a)}</tem:int>`).join('')}</tem:childage>`
    : '         <tem:childage></tem:childage>';
  const hotelListXml = hotelList.length > 0
    ? hotelList.map(id => `<tem:int>${parseInt(id)}</tem:int>`).join('')
    : '';
 
  const body = `      <tem:cityid>${parseInt(cityId)}</tem:cityid>
      <tem:arrival>${fmtDate(arrival)}</tem:arrival>
      <tem:departure>${fmtDate(departure)}</tem:departure>
      <tem:qty>${parseInt(qty)}</tem:qty>
      <tem:paxlist>
         <tem:adults>${parseInt(adults)}</tem:adults>
         <tem:child>${parseInt(children)}</tem:child>
${childAgesXml}
      </tem:paxlist>
      <tem:availableonly>${parseInt(availableOnly)}</tem:availableonly>
      <tem:hotellist>${hotelListXml}</tem:hotellist>`;
 
  return await callEnixHotels('SearchHotelAdvancedV1', body);
}
 
// =====================================================================
// ENDPOINTS REST
// =====================================================================
 
app.get('/', (req, res) => {
  res.json({
    service: 'Magic Travelers Backend',
    status: 'OK',
    version: '4.0.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET  /                              - healthcheck',
      'GET  /api/hotels-list               - lista hoteles Disney/Universal (cache 1h)',
      'POST /api/search-simple             - SearchHotel (sólo hotel)',
      'POST /api/search-with-tickets       - SearchHotel_MainRoomResults (hotel + tickets)',
      'GET  /api/promos-disney             - promos activas Disney',
      'POST /api/search-legacy             - SearchHotelAdvancedV1 (Service_Hotels, no Disney)',
      'POST /api/chat                      - chat IA con Claude',
      'GET  /api/diag                      - diagnóstico cache + config',
    ],
  });
});
 
app.get('/api/diag', async (req, res) => {
  const cached = hotelsCache.data;
  const cacheAge = hotelsCache.timestamp ? Date.now() - hotelsCache.timestamp : null;
  res.json({
    cache: {
      hasData: !!cached,
      count: cached?.length || 0,
      ageSeconds: cacheAge ? Math.round(cacheAge / 1000) : null,
      ttlSeconds: HOTELS_CACHE_TTL / 1000,
    },
    samples: cached?.slice(0, 3) || [],
    parkTypes: cached ? [...new Set(cached.map(h => h.parkType).filter(Boolean))] : [],
    promosCache: {
      hasData: !!promosCache.data,
      count: promosCache.data?.length || 0,
    },
    config: {
      margin: ENIX_CONFIG.margin,
      claudeModel: MAGIC_CONFIG.claudeModel,
    },
  });
});
 
app.get('/api/hotels-list', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const hotels = await getHotelsList({ force });
  if (!hotels) {
    return res.status(503).json({ success: false, error: 'No se pudo obtener la lista' });
  }
  const parkTypes = [...new Set(hotels.map(h => h.parkType).filter(Boolean))];
  res.json({ success: true, count: hotels.length, parkTypes, hotels });
});
 
app.post('/api/search-simple', async (req, res) => {
  const { type = 'All', arrival, departure, adults = 2, children = 0, childAges = [] } = req.body;
  if (!arrival || !departure) {
    return res.status(400).json({ success: false, error: 'arrival y departure son requeridos' });
  }
  const result = await searchHotelSimple({ type, arrival, departure, adults, children, childAges });
  res.json(result);
});
 
app.post('/api/search-with-tickets', async (req, res) => {
  const { type = 'All', arrival, departure, adults = 2, children = 0, childAges = [], ticketDays = 4 } = req.body;
  if (!arrival || !departure) {
    return res.status(400).json({ success: false, error: 'arrival y departure son requeridos' });
  }
  const result = await searchHotelWithTickets({ type, arrival, departure, adults, children, childAges, ticketDays });
  res.json(result);
});
 
app.get('/api/promos-disney', async (req, res) => {
  const promos = await getPromosDisney();
  res.json({ success: true, count: promos.length, promos });
});
 
app.post('/api/search-legacy', async (req, res) => {
  const { cityId, arrival, departure, adults = 2, children = 0, childAges = [], qty = 1, hotelList = [] } = req.body;
  if (!arrival || !departure) {
    return res.status(400).json({ success: false, error: 'arrival y departure son requeridos' });
  }
  const result = await searchHotelsAdvancedLegacy({
    cityId: cityId || ENIX_CONFIG.orlandoCityId,
    arrival, departure, adults, children, childAges, qty, hotelList,
  });
  res.json(result);
});
 
// ---------------------------------------------------------------------
// DEBUG: muestra el XML CRUDO de ENIX para inspección.
// Útil para descubrir la estructura real de la respuesta cuando el parser
// devuelve vacío. Soporta cualquier método de Service_Parks.
// ---------------------------------------------------------------------
app.post('/api/debug-raw', async (req, res) => {
  const {
    method = 'SearchHotel',
    type = 'Disney',
    arrival = '2026-08-12',
    departure = '2026-08-19',
    adults = 2,
    children = 0,
    childAges = [],
    ticketDays = 4,
  } = req.body;
 
  const fmtDate = (d) => (d.includes('T') ? d : `${d}T00:00:00`);
  const childAgesXml = childAges.length > 0
    ? `<childage>${childAges.map(a => `<int>${parseInt(a)}</int>`).join('')}</childage>`
    : '<childage></childage>';
 
  let body = '';
  if (method === 'SearchHotel') {
    body = `<type>${type}</type>
<arrival>${fmtDate(arrival)}</arrival>
<departure>${fmtDate(departure)}</departure>
<paxlist>
  <adults>${parseInt(adults)}</adults>
  <child>${parseInt(children)}</child>
  ${childAgesXml}
</paxlist>`;
  } else if (method === 'SearchHotel_MainRoomResults') {
    body = `<type>${type}</type>
<arrival>${fmtDate(arrival)}</arrival>
<departure>${fmtDate(departure)}</departure>
<paxlist>
  <adults>${parseInt(adults)}</adults>
  <child>${parseInt(children)}</child>
  ${childAgesXml}
</paxlist>
<TicketDays>${parseInt(ticketDays)}</TicketDays>`;
  } else if (method === 'GetHotelMaster' || method === 'GetPromoMasterDisney') {
    body = '';
  } else {
    return res.status(400).json({ error: `Método no soportado en debug: ${method}` });
  }
 
  const sentEnvelope = buildSoap11(method, body);
  const result = await callEnixParks(method, body);
 
  res.json({
    method,
    sent: {
      endpoint: ENIX_CONFIG.parksEndpoint,
      soapAction: `"${ENIX_CONFIG.namespace}${method}"`,
      envelope: sentEnvelope,
    },
    received: {
      success: result.success,
      status: result.status,
      error: result.error || null,
      xmlLength: result.data ? result.data.length : 0,
      xmlRaw: result.data || result.details || null,
    },
  });
});
 
// =====================================================================
// CLAUDE AI CHAT
// =====================================================================
 
const SYSTEM_PROMPT = `Sos el asesor de viajes de Magic Travelers, una agencia argentina especializada en Disney y Universal Orlando.
 
# Tu personalidad
- Cálido y profesional, como Pablo, Noe o Maru — los humanos que atienden Magic Travelers.
- Hablás natural, sin emojis a cascotazos, sin "¡Hola amig@!". Tono argentino si el cliente escribe en español rioplatense.
- Detectás automáticamente el idioma del cliente (español, inglés, portugués) y respondés siempre en el mismo idioma.
- Sos experto en Disney y Universal: hoteles, tickets, dining plans, mejores épocas, edades, etc.
 
# Tu flujo de trabajo
1. Saludá brevemente y preguntá qué necesita.
2. Hacé preguntas cortas para entender: destino (Disney/Universal/ambos), fechas, cantidad de adultos y niños (con edades).
3. Decidí qué tool usar:
   - Si el cliente sólo quiere ver hoteles → usá \`buscar_hoteles_simple\`.
   - Si menciona tickets de parque, días en parques, "paquete completo" → usá \`buscar_hoteles_con_tickets\` (devuelve hotel + tickets en un combo).
   - Si pregunta qué hoteles existen sin fechas → usá \`listar_hoteles\`.
   - Si pregunta por descuentos/promos → usá \`obtener_promos_disney\`.
4. Mostrá 2-3 opciones que se ajusten al perfil del cliente (NO abrumes con 35 hoteles).
5. Cuando esté listo para cerrar, usá \`generar_link_whatsapp\` para pasarlo a un humano.
 
# REGLAS CRÍTICAS que NUNCA rompas
- NUNCA inventes precios. Si una tool no devuelve precio, derivá a WhatsApp.
- Los precios que devuelven las tools YA TIENEN el margen del 10% incluido. Mostralos tal cual, NO sumes nada.
- NUNCA prometas disponibilidad que no validaste con las tools.
- Si una tool devuelve 0 resultados o error, NO digas "no hay disponibilidad" — derivá a WhatsApp con todos los datos.
- Si el cliente pregunta por destinos que NO son Disney/Universal Orlando, decile amablemente que en chat sólo manejás esos dos, y derivalo a WhatsApp.
 
# Cómo decidir entre las dos tools de búsqueda
- "Quiero un hotel cerca de Disney" → \`buscar_hoteles_simple\` (no menciona tickets)
- "Quiero ir 5 días a Disney" → \`buscar_hoteles_con_tickets\` con ticketDays=5
- "Quiero el paquete completo con tickets para Universal" → \`buscar_hoteles_con_tickets\` con type=Universal
- "Cuánto sale el All Star Music sólo el hotel" → \`buscar_hoteles_simple\`
- Si dudás, preguntale al cliente si quiere "sólo hotel" o "hotel + tickets de parque"
 
# Info útil sobre Disney/Universal
- Disney Value (~$130-180/noche): All Star Movies, All Star Music, All Star Sports, Pop Century, Art of Animation
- Disney Moderate (~$200-280/noche): Caribbean Beach, Port Orleans, Coronado Springs
- Disney Deluxe (~$450-700/noche): Contemporary, Grand Floridian, Polynesian, Wilderness Lodge, Animal Kingdom Lodge, Beach Club, Yacht Club, BoardWalk, Riviera
- Universal Prime Value (~$140-180/noche): Endless Summer Dockside, Endless Summer Surfside
- Universal Prime Value Plus (~$200-240/noche): Cabana Bay, Aventura
- Universal Preferred (~$280-340/noche): Sapphire Falls
- Universal Premier con Express Pass GRATIS (~$380-500/noche): Royal Pacific, Hard Rock, Portofino Bay
- Mejor época Disney: enero-febrero, mayo, septiembre-octubre. Evitar vacaciones americanas.
- Magic Travelers cobra 10% sobre tarifas mayoristas, aún así sale ~25% más barato que Disney directo.
 
Sé útil, sé conciso, derivá a WhatsApp cuando dudes.`;
 
const tools = [
  {
    name: 'listar_hoteles',
    description: 'Devuelve la lista completa de hoteles oficiales Disney y Universal Orlando, sin precios ni disponibilidad. Úsala cuando el cliente pregunta "qué hoteles hay" SIN haber dado fechas todavía.',
    input_schema: {
      type: 'object',
      properties: {
        parque: { type: 'string', enum: ['Disney', 'Universal', 'All'] },
      },
      required: ['parque'],
    },
  },
  {
    name: 'buscar_hoteles_simple',
    description: 'Busca hoteles Disney/Universal con precios SÓLO de hotel (sin tickets de parque). Usala cuando el cliente quiere ver opciones de hospedaje y todavía no decidió o no necesita los tickets. Devuelve hotel + habitaciones + tarifas por noche.',
    input_schema: {
      type: 'object',
      properties: {
        parque: { type: 'string', enum: ['Disney', 'Universal', 'All'] },
        check_in: { type: 'string', description: 'Fecha YYYY-MM-DD' },
        check_out: { type: 'string', description: 'Fecha YYYY-MM-DD' },
        adultos: { type: 'integer' },
        ninos: { type: 'integer' },
        edades_ninos: { type: 'array', items: { type: 'integer' } },
      },
      required: ['parque', 'check_in', 'check_out', 'adultos'],
    },
  },
  {
    name: 'buscar_hoteles_con_tickets',
    description: 'Busca hoteles Disney/Universal CON tickets de parque incluidos (paquete completo). Usala cuando el cliente menciona días en parques, paquete, combo, o quiere todo junto. Devuelve hotel + tickets en un solo precio.',
    input_schema: {
      type: 'object',
      properties: {
        parque: { type: 'string', enum: ['Disney', 'Universal', 'All'] },
        check_in: { type: 'string', description: 'Fecha YYYY-MM-DD' },
        check_out: { type: 'string', description: 'Fecha YYYY-MM-DD' },
        adultos: { type: 'integer' },
        ninos: { type: 'integer' },
        edades_ninos: { type: 'array', items: { type: 'integer' } },
        dias_de_parque: {
          type: 'integer',
          description: 'Cantidad de días que el cliente quiere visitar parques (típicamente 3-7). Si no lo mencionó, preguntalo antes.',
        },
      },
      required: ['parque', 'check_in', 'check_out', 'adultos', 'dias_de_parque'],
    },
  },
  {
    name: 'obtener_promos_disney',
    description: 'Devuelve las promociones activas de Disney. Usala cuando el cliente pregunta por descuentos, promos, ofertas especiales.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'generar_link_whatsapp',
    description: 'Genera un link de WhatsApp listo para derivar al cliente a un asesor humano. Usalo cuando: el cliente está listo para cerrar, alguna tool falló, o pregunta algo que requiere humano (pagos, dudas legales, viajes a destinos que no son Disney/Universal).',
    input_schema: {
      type: 'object',
      properties: {
        resumen: {
          type: 'string',
          description: 'Resumen completo del paquete en primera persona desde el cliente. Incluí destino, fechas, cantidad de personas, hoteles que le interesaron, precio aproximado.',
        },
        idioma: { type: 'string', enum: ['es', 'en', 'pt'] },
      },
      required: ['resumen'],
    },
  },
];
 
async function executeTool(toolName, toolInput) {
  console.log(`[TOOL] ${toolName}`, JSON.stringify(toolInput));
 
  try {
    if (toolName === 'listar_hoteles') {
      const all = await getHotelsList();
      if (!all || all.length === 0) {
        return { error: 'No pude obtener la lista ahora. Derivá a WhatsApp con generar_link_whatsapp.' };
      }
      const filtered = filterByPark(all, toolInput.parque);
      return {
        cantidad: filtered.length,
        hoteles: filtered.map(h => ({ id: h.hotelId, nombre: h.name, parque: h.parkType })),
      };
    }
 
    if (toolName === 'buscar_hoteles_simple') {
      const { parque, check_in, check_out, adultos, ninos = 0, edades_ninos = [] } = toolInput;
      const result = await searchHotelSimple({
        type: parque, arrival: check_in, departure: check_out,
        adults: adultos, children: ninos, childAges: edades_ninos,
      });
 
      if (!result.success) {
        return { aviso: 'Error técnico. NO le digas al cliente "no hay" — derivá a WhatsApp.', error_tecnico: result.error };
      }
      if (result.totalRecords === 0 || result.hotels.length === 0) {
        return { aviso: 'Sin resultados. NO le digas "no hay disponibilidad" — derivá a WhatsApp con todos los datos.', cantidad: 0 };
      }
 
      const top = result.hotels
        .filter(h => h.minPrice > 0)
        .sort((a, b) => a.minPrice - b.minPrice)
        .slice(0, 6);
 
      return {
        metodo: result.method,
        total_disponibles: result.totalRecords,
        hoteles: top.map(h => ({
          id: h.hotelId,
          nombre: h.name,
          parque: h.parkType,
          precio_minimo_total_usd: h.minPrice,
          opciones: h.rooms.slice(0, 2).map(r => ({
            habitacion: r.roomType,
            tarifas: r.options.slice(0, 2).map(o => ({
              board: o.board,
              precio_total_usd: o.finalPrice,
            })),
          })),
        })),
        nota: 'Precios finales con margen Magic Travelers. NO sumes nada.',
      };
    }
 
    if (toolName === 'buscar_hoteles_con_tickets') {
      const { parque, check_in, check_out, adultos, ninos = 0, edades_ninos = [], dias_de_parque } = toolInput;
      const result = await searchHotelWithTickets({
        type: parque, arrival: check_in, departure: check_out,
        adults: adultos, children: ninos, childAges: edades_ninos,
        ticketDays: dias_de_parque,
      });
 
      if (!result.success) {
        return { aviso: 'Error técnico. NO le digas "no hay" — derivá a WhatsApp.', error_tecnico: result.error };
      }
      if (result.totalRecords === 0 || result.hotels.length === 0) {
        return { aviso: 'Sin resultados para ese paquete. NO le digas "no hay" — derivá a WhatsApp.', cantidad: 0 };
      }
 
      const top = result.hotels
        .filter(h => h.minPrice > 0)
        .sort((a, b) => a.minPrice - b.minPrice)
        .slice(0, 6);
 
      return {
        metodo: result.method,
        dias_parque: result.ticketDays,
        total_disponibles: result.totalRecords,
        hoteles: top.map(h => ({
          id: h.hotelId,
          nombre: h.name,
          parque: h.parkType,
          precio_paquete_total_usd: h.minPrice,
          opciones: h.rooms.slice(0, 2).map(r => ({
            habitacion: r.roomType,
            tarifas: r.options.slice(0, 2).map(o => ({
              ticket: o.ticketName || o.ticketType,
              board: o.board,
              precio_paquete_usd: o.finalPrice,
            })),
          })),
        })),
        nota: 'Precios paquete completo (hotel + tickets), margen ya incluido.',
      };
    }
 
    if (toolName === 'obtener_promos_disney') {
      const promos = await getPromosDisney();
      if (!promos || promos.length === 0) {
        return { cantidad: 0, mensaje: 'No hay promos activas en este momento.' };
      }
      return {
        cantidad: promos.length,
        promos: promos.map(p => ({
          nombre: p.name,
          descripcion: p.description,
          vigencia: p.validFrom && p.validTo ? `${p.validFrom} a ${p.validTo}` : null,
          descuento: p.discount,
        })),
      };
    }
 
    if (toolName === 'generar_link_whatsapp') {
      const { resumen, idioma = 'es' } = toolInput;
      const greeting = {
        es: '¡Hola! Vengo del cotizador inteligente.',
        en: 'Hi! I come from the AI quote chat.',
        pt: 'Olá! Venho do cotizador inteligente.',
      }[idioma] || '¡Hola! Vengo del cotizador inteligente.';
      const fullMessage = `${greeting}\n\n${resumen}`;
      const url = `https://wa.me/${MAGIC_CONFIG.whatsappNumber}?text=${encodeURIComponent(fullMessage)}`;
      return { url };
    }
 
    return { error: `Tool desconocida: ${toolName}` };
  } catch (e) {
    console.error('[TOOL ERROR]', toolName, e.message);
    return { error: `Error ejecutando ${toolName}: ${e.message}` };
  }
}
 
app.post('/api/chat', async (req, res) => {
  const { messages = [] } = req.body;
 
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'messages es requerido (array)' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY no configurada' });
  }
 
  const history = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
 
  try {
    let iterations = 0;
    const maxIterations = 6;
 
    while (iterations < maxIterations) {
      iterations++;
 
      const response = await anthropic.messages.create({
        model: MAGIC_CONFIG.claudeModel,
        max_tokens: MAGIC_CONFIG.claudeMaxTokens,
        system: SYSTEM_PROMPT,
        tools,
        messages: history,
      });
 
      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const toolResults = await Promise.all(
          toolUseBlocks.map(async (tu) => {
            const result = await executeTool(tu.name, tu.input);
            return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
          })
        );
        history.push({ role: 'assistant', content: response.content });
        history.push({ role: 'user', content: toolResults });
        continue;
      }
 
      const textBlocks = response.content.filter(b => b.type === 'text');
      const finalText = textBlocks.map(b => b.text).join('\n').trim();
 
      return res.json({ success: true, message: finalText, usage: response.usage, iterations });
    }
 
    return res.status(500).json({ success: false, error: 'Max iterations alcanzado' });
 
  } catch (error) {
    console.error('[CHAT ERROR]', error);
    return res.status(500).json({ success: false, error: error.message, type: error.type || 'unknown' });
  }
});
 
// =====================================================================
// ARRANQUE
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Magic Travelers backend v4 listening on port ${PORT}`);
  console.log(`Parks endpoint:  ${ENIX_CONFIG.parksEndpoint}`);
  console.log(`Hotels endpoint: ${ENIX_CONFIG.hotelsEndpoint}`);
  console.log(`Claude model:    ${MAGIC_CONFIG.claudeModel}`);
 
  console.log('[STARTUP] Precalentando cache de hoteles...');
  const hotels = await getHotelsList();
  if (hotels) {
    const parks = [...new Set(hotels.map(h => h.parkType).filter(Boolean))];
    console.log(`[STARTUP] Cache: ${hotels.length} hoteles, parques: ${parks.join(', ')}`);
  } else {
    console.warn('[STARTUP] No se pudo precalentar cache.');
  }
});
