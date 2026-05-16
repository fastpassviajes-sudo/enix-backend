// =====================================================================
// MAGIC TRAVELERS - Backend ENIX + Claude AI v3
// =====================================================================
// Cambios clave vs v2:
//   1. GetHotelMaster ahora se llama con parámetros (countryId/cityid/zoneid)
//      sobre el endpoint correcto (Service_Parks) y se cachea 1h.
//   2. Lista hardcodeada de hoteles Disney/Universal como FALLBACK
//      por si Service_Parks no responde (Render free a veces tarda en arrancar).
//   3. SearchHotelAdvancedV1 usa <hotellist> con IDs en vez de <cityid>,
//      lo que evita depender del cityId de Orlando (que sigue sin confirmarse).
//   4. /api/hotels-list ahora SIEMPRE devuelve parkType correcto.
//   5. Nuevo: /api/hotel-master para descubrir hoteles por country/city/zone
//      (útil para encontrar el cityId real de Orlando cuando responda Víctor).
//   6. Nuevo: /api/book-preview (BookHotelPreviewV1) para revalidar precios
//      antes de pasar al cliente al WhatsApp.
//   7. Mejor parser: respeta jerarquía Hotel > Room > Option > Rate.
//   8. Mejor SOAPAction: usa el header correcto para SOAP 1.2.
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
 
  // Orlando / Estados Unidos. Si Víctor confirma otros, cambiar acá.
  // OJO: 729 funciona en Service_Parks (tickets). Para Service_Hotels NO sabemos
  // todavía cuál es. Por eso preferimos buscar por hotellist en vez de cityid.
  orlandoCityId: parseInt(process.env.ORLANDO_CITY_ID || '729'),
  usaCountryId: parseInt(process.env.USA_COUNTRY_ID || '0'),
  orlandoZoneId: parseInt(process.env.ORLANDO_ZONE_ID || '0'),
};
 
const MAGIC_CONFIG = {
  whatsappNumber: process.env.MAGIC_WHATSAPP || '5491121882210',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  claudeMaxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS || '2048'),
};
 
const anthropic = new Anthropic();
 
// ---------------------------------------------------------------------
// FALLBACK: lista hardcodeada de hotelIds Disney/Universal
// Si Service_Parks falla, usamos esto para que /api/search igual funcione.
// Cuando el backend arranca, se sobreescribe con la lista real fresca.
// IMPORTANTE: estos IDs son los 35 que ya nos confirmó Víctor y se ven
// en /api/hotels-list. Si la lista cambia, actualizar acá.
// ---------------------------------------------------------------------
const FALLBACK_HOTELS = [
  // Disney - completar con IDs reales tras primera llamada exitosa
  // a /api/hotels-list. Por ahora dejamos placeholder para que el sistema
  // arranque aun si Service_Parks está caído.
];
 
// ---------------------------------------------------------------------
// HELPERS XML
// ---------------------------------------------------------------------
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
 
// Extrae el contenido de TODAS las apariciones de un tag (a cualquier profundidad).
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
 
// Versión que respeta jerarquía: extrae tags hijos directos del primer nivel.
// Útil para no confundir un <Type> dentro de <Rate> con un <Type> dentro de <Hotel>.
function extractDirectChild(parentXml, tag) {
  // Buscamos solo en el primer nivel: no entramos en sub-elementos.
  // Truco: buscamos el primer <tag>...</tag> que no esté precedido por
  // tags abiertos sin cerrar. Para SOAP responses esto suele alcanzar.
  return extractFirst(parentXml, tag);
}
 
// ---------------------------------------------------------------------
// SOAP 1.1 (Service_Parks.asmx)
// ---------------------------------------------------------------------
function buildSoap11(methodName, bodyContent = '') {
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
      timeout: 60000,
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
// SOAP 1.2 (Service_Hotels.asmx)
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
        // SOAP 1.2: el action va EN el Content-Type, no en SOAPAction header
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
  // GetHotelMaster en Service_Parks.asmx devuelve <Hotel> con campos planos.
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
 
function parseSearchHotelAdvancedV1(xml) {
  const totalRecords = parseInt(extractFirst(xml, 'TotalRecords') || '0');
  const totalPages = parseInt(extractFirst(xml, 'TotalPages') || '0');
  const pageSize = parseInt(extractFirst(xml, 'PageSize') || '0');
  const targetPage = parseInt(extractFirst(xml, 'TargetPage') || '0');
 
  // Si TotalRecords es 0 o el XML viene vacío, retornamos rápido.
  if (totalRecords === 0) {
    return { totalRecords: 0, totalPages, pageSize, targetPage, hotels: [] };
  }
 
  // Parsear hoteles. Cada <Hotel> tiene <Room>s y cada Room tiene <Option>s.
  // OJO: una respuesta puede tener <Hotel> con shape diferente a <Hotel> de
  // GetHotelMaster. Para Search los campos clave son: Id, Name, Room.
  const hotels = extractTagAll(xml, 'Hotel');
  const parsedHotels = hotels.map(h => {
    const hotelId = extractFirst(h, 'Id');
    const name = (extractFirst(h, 'Name') || '').trim();
 
    const rooms = extractTagAll(h, 'Room');
    const parsedRooms = rooms.map(r => {
      const roomType = (extractFirst(r, 'RoomType') || '').trim();
      const roomId = extractFirst(r, 'RoomID') || extractFirst(r, 'RoomId');
 
      const options = extractTagAll(r, 'Option');
      const parsedOptions = options.map(opt => {
        // Los campos de precio están dentro de <Option> al mismo nivel
        // que BookParam / OptionStatus. <Rate> envuelve type y MaxOccup.
        const rateBlock = extractFirst(opt, 'Rate') || opt;
 
        const netNightsTotal = parseFloat(extractFirst(opt, 'OptionNightsTotal') || '0');
        const netNightsNetTotal = parseFloat(
          extractFirst(opt, 'OptionNightsNetTotal') ||
          extractFirst(opt, 'OptionNightsTotal') ||
          '0'
        );
 
        const finalPrice = Math.round(netNightsTotal * ENIX_CONFIG.margin * 100) / 100;
 
        return {
          optionId: extractFirst(opt, 'OptionID') || extractFirst(opt, 'OptionId'),
          bookParam: extractFirst(opt, 'BookParam'),
          board: (extractFirst(opt, 'Board') || '').trim(),
          status: extractFirst(opt, 'OptionStatus'),
          rateType: extractFirst(rateBlock, 'Type'),
          maxOccup: parseInt(extractFirst(rateBlock, 'MaxOccup') || '0'),
          accId: extractFirst(rateBlock, 'AccId'),
          netPrice: netNightsTotal,
          netTotal: netNightsNetTotal,
          finalPrice,
          currency: 'USD',
        };
      });
 
      return { roomType, roomId, options: parsedOptions };
    });
 
    const allPrices = parsedRooms
      .flatMap(r => r.options.map(o => o.finalPrice))
      .filter(p => p > 0);
    const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : null;
 
    return { hotelId, name, rooms: parsedRooms, minPrice };
  });
 
  return { totalRecords, totalPages, pageSize, targetPage, hotels: parsedHotels };
}
 
function parseBookHotelPreview(xml) {
  // BookHotelPreviewV1 devuelve precio firme. Estructura simplificada.
  const status = extractFirst(xml, 'Status');
  const finalNetPrice = parseFloat(extractFirst(xml, 'NetTotal') || extractFirst(xml, 'OptionNightsTotal') || '0');
  const cancellation = extractFirst(xml, 'Cancellation') || extractFirst(xml, 'CxlPolicy');
  return {
    status,
    netPrice: finalNetPrice,
    finalPrice: Math.round(finalNetPrice * ENIX_CONFIG.margin * 100) / 100,
    currency: 'USD',
    cancellationPolicy: cancellation,
  };
}
 
// ---------------------------------------------------------------------
// CACHE de hoteles Disney/Universal (Service_Parks/GetHotelMaster)
// ---------------------------------------------------------------------
let hotelsCache = { data: null, timestamp: 0 };
const HOTELS_CACHE_TTL = 60 * 60 * 1000; // 1 hora
 
async function getHotelsList({ force = false } = {}) {
  if (!force && hotelsCache.data && Date.now() - hotelsCache.timestamp < HOTELS_CACHE_TTL) {
    return hotelsCache.data;
  }
 
  // GetHotelMaster requiere countryId/cityid/zoneid según el WSDL.
  // Pasamos 0 como "todos" — funciona en el endpoint de Parks.
  const body = `<countryId>${ENIX_CONFIG.usaCountryId}</countryId>
<cityid>${ENIX_CONFIG.orlandoCityId}</cityid>
<zoneid>${ENIX_CONFIG.orlandoZoneId}</zoneid>`;
 
  const result = await callEnixParks('GetHotelMaster', body);
  if (!result.success) {
    console.warn('[CACHE] GetHotelMaster falló, usando fallback hardcodeado');
    if (hotelsCache.data) return hotelsCache.data; // mantener cache vieja antes que nada
    return FALLBACK_HOTELS.length > 0 ? FALLBACK_HOTELS : null;
  }
 
  const hotels = parseHotelMasterList(result.data);
  if (hotels.length === 0) {
    console.warn('[CACHE] GetHotelMaster devolvió 0 hoteles, usando cache vieja o fallback');
    if (hotelsCache.data) return hotelsCache.data;
    return FALLBACK_HOTELS.length > 0 ? FALLBACK_HOTELS : null;
  }
 
  hotelsCache = { data: hotels, timestamp: Date.now() };
  console.log(`[CACHE] Refrescado con ${hotels.length} hoteles`);
  return hotels;
}
 
// Helper para filtrar Disney / Universal con tolerancia a variaciones en el campo
function filterByPark(hotels, parque) {
  if (!parque || parque === 'All') return hotels;
  const target = parque.toLowerCase();
  return hotels.filter(h => {
    if (!h.parkType) return false;
    return h.parkType.toLowerCase().includes(target);
  });
}
 
// ---------------------------------------------------------------------
// BÚSQUEDA: SearchHotelAdvancedV1
// Soporta dos modos:
//   - por cityId (modo "amplio" — falla si no sabemos el cityId real)
//   - por hotelList (modo "preciso" — el que funciona con Disney/Universal)
// ---------------------------------------------------------------------
async function searchHotelsAdvanced({
  cityId = ENIX_CONFIG.orlandoCityId,
  arrival,
  departure,
  adults = 2,
  children = 0,
  childAges = [],
  qty = 1,
  hotelList = [],
  availableOnly = 1,
}) {
  const fmtDate = (d) => (d.includes('T') ? d : `${d}T00:00:00`);
 
  const childAgesXml = childAges.length > 0
    ? `         <tem:childage>${childAges.map(a => `<tem:int>${parseInt(a)}</tem:int>`).join('')}</tem:childage>`
    : '         <tem:childage></tem:childage>';
 
  const hotelListXml = hotelList.length > 0
    ? hotelList.map(id => `<tem:int>${parseInt(id)}</tem:int>`).join('')
    : '';
 
  // Cuando hotelList tiene IDs, cityId se ignora del lado del servicio,
  // pero igual lo mandamos por si es obligatorio del schema.
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
 
  const result = await callEnixHotels('SearchHotelAdvancedV1', body);
  if (!result.success) return result;
 
  const parsed = parseSearchHotelAdvancedV1(result.data);
  return {
    success: true,
    ...parsed,
    margin: ENIX_CONFIG.margin,
    searchedBy: hotelList.length > 0 ? 'hotelList' : 'cityId',
    note: 'Los precios en finalPrice ya incluyen el margen del 10% de Magic Travelers',
  };
}
 
// ---------------------------------------------------------------------
// BOOK PREVIEW (para revalidar precio antes de derivar a WhatsApp)
// ---------------------------------------------------------------------
async function bookHotelPreview({
  bookParam, arrival, departure, hotelId, roomId, optionId,
  accomodationId = 1, maxPax = 4, roomQty = 1,
  adults = 2, children = 0, childAges = [],
}) {
  const fmtDate = (d) => (d.includes('T') ? d : `${d}T00:00:00`);
  const childAgesXml = childAges.length > 0
    ? `<tem:childage>${childAges.map(a => `<tem:int>${parseInt(a)}</tem:int>`).join('')}</tem:childage>`
    : '<tem:childage></tem:childage>';
 
  const body = `      <tem:BookParam>${escapeXml(bookParam)}</tem:BookParam>
      <tem:arrival>${fmtDate(arrival)}</tem:arrival>
      <tem:departure>${fmtDate(departure)}</tem:departure>
      <tem:hotelid>${parseInt(hotelId)}</tem:hotelid>
      <tem:roomid>${parseInt(roomId)}</tem:roomid>
      <tem:optionid>${parseInt(optionId)}</tem:optionid>
      <tem:accomodationid>${parseInt(accomodationId)}</tem:accomodationid>
      <tem:maxpax>${parseInt(maxPax)}</tem:maxpax>
      <tem:roomqty>${parseInt(roomQty)}</tem:roomqty>
      <tem:paxlist>
         <tem:adults>${parseInt(adults)}</tem:adults>
         <tem:child>${parseInt(children)}</tem:child>
         ${childAgesXml}
      </tem:paxlist>
      <tem:MealSelection></tem:MealSelection>
      <tem:RfeeSelection></tem:RfeeSelection>`;
 
  const result = await callEnixHotels('BookHotelPreviewV1', body);
  if (!result.success) return result;
  return { success: true, ...parseBookHotelPreview(result.data), raw: result.data };
}
 
// =====================================================================
// ENDPOINTS REST
// =====================================================================
 
app.get('/', (req, res) => {
  res.json({
    service: 'Magic Travelers Backend',
    status: 'OK',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET  /                        - healthcheck',
      'GET  /api/hotels-list         - lista hoteles Disney/Universal (cache 1h)',
      'GET  /api/hotels-list?force=1 - fuerza refresh de la cache',
      'POST /api/hotel-master        - GetHotelMaster con countryId/cityid/zoneid custom',
      'POST /api/search              - búsqueda con precios (SearchHotelAdvancedV1)',
      'POST /api/book-preview        - revalidar precio antes de cerrar (BookHotelPreviewV1)',
      'POST /api/chat                - chat IA con Claude',
      'GET  /api/diag                - diagnóstico de la cache y endpoints',
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
    parkTypes: cached
      ? [...new Set(cached.map(h => h.parkType).filter(Boolean))]
      : [],
    config: {
      orlandoCityId: ENIX_CONFIG.orlandoCityId,
      margin: ENIX_CONFIG.margin,
      claudeModel: MAGIC_CONFIG.claudeModel,
    },
  });
});
 
app.get('/api/hotels-list', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const hotels = await getHotelsList({ force });
  if (!hotels) {
    return res.status(503).json({
      success: false,
      error: 'No se pudo obtener la lista de hoteles. Service_Parks no responde y no hay cache.',
    });
  }
  const parkTypes = [...new Set(hotels.map(h => h.parkType).filter(Boolean))];
  res.json({ success: true, count: hotels.length, parkTypes, hotels });
});
 
app.post('/api/hotel-master', async (req, res) => {
  const { countryId = 0, cityId = 0, zoneId = 0 } = req.body;
  const body = `<countryId>${parseInt(countryId)}</countryId>
<cityid>${parseInt(cityId)}</cityid>
<zoneid>${parseInt(zoneId)}</zoneid>`;
  const result = await callEnixParks('GetHotelMaster', body);
  if (!result.success) return res.status(500).json(result);
  const hotels = parseHotelMasterList(result.data);
  res.json({ success: true, count: hotels.length, hotels });
});
 
app.post('/api/search', async (req, res) => {
  const {
    cityId,
    arrival,
    departure,
    adults = 2,
    children = 0,
    childAges = [],
    qty = 1,
    hotelList = [],
    availableOnly = 1,
  } = req.body;
 
  if (!arrival || !departure) {
    return res.status(400).json({ success: false, error: 'arrival y departure son requeridos (YYYY-MM-DD)' });
  }
 
  const result = await searchHotelsAdvanced({
    cityId: cityId || ENIX_CONFIG.orlandoCityId,
    arrival, departure, adults, children, childAges, qty, hotelList, availableOnly,
  });
  res.json(result);
});
 
app.post('/api/book-preview', async (req, res) => {
  const required = ['bookParam', 'arrival', 'departure', 'hotelId', 'roomId', 'optionId'];
  for (const k of required) {
    if (!req.body[k]) {
      return res.status(400).json({ success: false, error: `Falta ${k}` });
    }
  }
  const result = await bookHotelPreview(req.body);
  res.json(result);
});
 
// =====================================================================
// CLAUDE AI CHAT
// =====================================================================
 
const SYSTEM_PROMPT = `Sos el asesor de viajes de Magic Travelers, una agencia argentina especializada en Disney y Universal Orlando. Tu trabajo es ayudar a clientes a armar su paquete de viaje a estos destinos.
 
# Tu personalidad
- Cálido y profesional, como Pablo, Noe o Maru — los humanos que atienden Magic Travelers.
- Hablás natural, sin emojis a cascotazos, sin "¡Hola amig@!". Tono argentino si el cliente escribe en español rioplatense.
- Detectás automáticamente el idioma del cliente (español, inglés, portugués) y respondés siempre en el mismo idioma.
- Sos experto en Disney y Universal: hoteles, tickets, dining plans, mejores épocas, edades, etc.
 
# Cómo trabajás
1. Saludá brevemente y preguntá qué necesita.
2. Hacé preguntas cortas para entender: destino (Disney/Universal/ambos), fechas, cantidad de adultos y niños (con edades), presupuesto.
3. Cuando tengas la info clave, usá la tool \`buscar_hoteles\` para ver disponibilidad real con precios.
4. Mostrá 2-3 opciones que se ajusten al perfil del cliente (no abrumes con 35 hoteles).
5. Si pregunta por tickets/dining, usá \`calcular_paquete\` para sumar al hotel.
6. Cuando el cliente esté listo, usá \`generar_link_whatsapp\` para pasarlo a un humano que cierre la venta.
 
# Reglas críticas que NUNCA rompas
- NUNCA inventes precios. Si una tool no devuelve precio, derivá a WhatsApp.
- Los precios que devuelven las tools YA TIENEN el margen del 10% incluido. Mostralos tal cual.
- NUNCA prometas disponibilidad que no validaste con \`buscar_hoteles\`.
- Si el cliente pregunta por destinos que NO son Disney/Universal Orlando, decile amablemente que en chat solo manejás esos dos, y derivalo a WhatsApp.
- Si \`buscar_hoteles\` devuelve 0 resultados o error, NO digas "no hay disponibilidad" — derivá a WhatsApp con generar_link_whatsapp.
 
# Info útil
- Hoteles Disney por categoría:
  * Value (~$130-180/noche): All Star Movies, All Star Music, All Star Sports, Pop Century, Art of Animation
  * Moderate (~$200-280/noche): Caribbean Beach, Port Orleans, Coronado Springs
  * Deluxe (~$450-700/noche): Contemporary, Grand Floridian, Polynesian, Wilderness Lodge, Animal Kingdom Lodge, Beach Club, Yacht Club, BoardWalk, Riviera
- Hoteles Universal:
  * Prime Value (~$140-180/noche): Endless Summer Dockside, Endless Summer Surfside
  * Prime Value Plus (~$200-240/noche): Cabana Bay, Aventura
  * Preferred (~$280-340/noche): Sapphire Falls
  * Premier con Express Pass gratis (~$380-500/noche): Royal Pacific, Hard Rock, Portofino Bay
- Mejor época Disney: enero-febrero, mayo, septiembre-octubre. Evitar vacaciones americanas.
- Disney 4-Park Magic Ticket es la promo más popular de verano.
- Magic Travelers cobra 10% sobre tarifas mayoristas, aún así sale ~25% más barato que Disney directo.
 
Sé útil, sé conciso, derivá a WhatsApp cuando dudes.`;
 
const tools = [
  {
    name: 'listar_hoteles',
    description: 'Devuelve la lista completa de hoteles oficiales Disney y Universal Orlando. Útil cuando el cliente pregunta qué hoteles hay disponibles, SIN necesidad de fechas.',
    input_schema: {
      type: 'object',
      properties: {
        parque: {
          type: 'string',
          enum: ['Disney', 'Universal', 'All'],
          description: 'Filtrar por parque. "All" devuelve ambos.',
        },
      },
      required: ['parque'],
    },
  },
  {
    name: 'buscar_hoteles',
    description: 'Busca disponibilidad REAL de hoteles con precios para fechas específicas. ÚSALA cuando tengas fechas y cantidad de personas confirmadas. Los precios devueltos ya incluyen el margen de Magic Travelers.',
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
    name: 'calcular_paquete',
    description: 'Calcula el precio total de un paquete: hotel + tickets + dining plan.',
    input_schema: {
      type: 'object',
      properties: {
        precio_hotel_total: { type: 'number' },
        cantidad_personas: { type: 'integer' },
        cantidad_noches: { type: 'integer' },
        incluye_tickets: { type: 'boolean' },
        tipo_tickets: { type: 'string' },
        precio_tickets_total: { type: 'number' },
        incluye_dining: { type: 'boolean' },
        tipo_dining: { type: 'string' },
        precio_dining_total: { type: 'number' },
      },
      required: ['precio_hotel_total', 'cantidad_personas', 'cantidad_noches'],
    },
  },
  {
    name: 'generar_link_whatsapp',
    description: 'Genera un link de WhatsApp listo para derivar al cliente a un asesor humano.',
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
        return { error: 'No pude obtener la lista de hoteles ahora. Derivá a WhatsApp con generar_link_whatsapp.' };
      }
      const filtered = filterByPark(all, toolInput.parque);
      return {
        cantidad: filtered.length,
        hoteles: filtered.map(h => ({
          id: h.hotelId, nombre: h.name, parque: h.parkType,
        })),
      };
    }
 
    if (toolName === 'buscar_hoteles') {
      const { parque, check_in, check_out, adultos, ninos = 0, edades_ninos = [] } = toolInput;
 
      // ESTRATEGIA: siempre intentamos por hotelList (preciso, no depende de cityId)
      let hotelList = [];
      const all = await getHotelsList();
      if (all && all.length > 0) {
        const filtered = filterByPark(all, parque);
        hotelList = filtered.map(h => parseInt(h.hotelId)).filter(Boolean);
      }
 
      // Si no pudimos obtener la lista, intentamos por cityId como fallback.
      // (Es muy probable que falle hasta que Víctor confirme el cityId.)
      const result = await searchHotelsAdvanced({
        cityId: ENIX_CONFIG.orlandoCityId,
        arrival: check_in,
        departure: check_out,
        adults: adultos,
        children: ninos,
        childAges: edades_ninos,
        hotelList,
      });
 
      if (!result.success) {
        return {
          aviso: 'No se pudo consultar disponibilidad. NO le digas al cliente que no hay — derivá a WhatsApp con todos los datos.',
          error_tecnico: result.error,
        };
      }
 
      if (result.totalRecords === 0 || result.hotels.length === 0) {
        return {
          aviso: 'Sin resultados para esas fechas/parámetros. NO le digas al cliente "no hay" — derivá a WhatsApp con generar_link_whatsapp con todos los datos.',
          cantidad: 0,
          buscado_por: result.searchedBy,
        };
      }
 
      const topHotels = result.hotels
        .filter(h => h.minPrice > 0)
        .sort((a, b) => a.minPrice - b.minPrice)
        .slice(0, 8);
 
      return {
        total_disponibles: result.totalRecords,
        buscado_por: result.searchedBy,
        hoteles: topHotels.map(h => ({
          id: h.hotelId,
          nombre: h.name,
          precio_minimo_total_usd: h.minPrice,
          opciones_habitacion: h.rooms.slice(0, 3).map(r => ({
            tipo: r.roomType,
            tarifas: r.options.slice(0, 2).map(o => ({
              board: o.board, precio_total_usd: o.finalPrice,
            })),
          })),
        })),
        nota: 'Precios finales con margen Magic Travelers. NO sumes nada extra.',
      };
    }
 
    if (toolName === 'calcular_paquete') {
      const {
        precio_hotel_total = 0,
        cantidad_personas = 1,
        cantidad_noches = 1,
        incluye_tickets = false,
        tipo_tickets,
        precio_tickets_total = 0,
        incluye_dining = false,
        tipo_dining,
        precio_dining_total = 0,
      } = toolInput;
 
      const total = precio_hotel_total
        + (incluye_tickets ? precio_tickets_total : 0)
        + (incluye_dining ? precio_dining_total : 0);
      const ahorroEstimado = Math.round(total * 0.25);
 
      return {
        desglose: {
          hotel: precio_hotel_total,
          tickets: incluye_tickets ? { tipo: tipo_tickets, precio: precio_tickets_total } : null,
          dining: incluye_dining ? { tipo: tipo_dining, precio: precio_dining_total } : null,
        },
        total_usd: Math.round(total),
        cantidad_personas, cantidad_noches,
        ahorro_estimado_vs_directo_usd: ahorroEstimado,
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
    return res.status(500).json({
      success: false,
      error: 'ANTHROPIC_API_KEY no configurada en el servidor',
    });
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
            return {
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify(result),
            };
          })
        );
 
        history.push({ role: 'assistant', content: response.content });
        history.push({ role: 'user', content: toolResults });
        continue;
      }
 
      const textBlocks = response.content.filter(b => b.type === 'text');
      const finalText = textBlocks.map(b => b.text).join('\n').trim();
 
      return res.json({
        success: true,
        message: finalText,
        usage: response.usage,
        iterations,
      });
    }
 
    return res.status(500).json({
      success: false,
      error: 'Se alcanzó el máximo de iteraciones de tools.',
    });
 
  } catch (error) {
    console.error('[CHAT ERROR]', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      type: error.type || 'unknown',
    });
  }
});
 
// =====================================================================
// ARRANQUE
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Magic Travelers backend v3 listening on port ${PORT}`);
  console.log(`Parks endpoint:  ${ENIX_CONFIG.parksEndpoint}`);
  console.log(`Hotels endpoint: ${ENIX_CONFIG.hotelsEndpoint}`);
  console.log(`Claude model:    ${MAGIC_CONFIG.claudeModel}`);
  console.log(`Margin:          ${ENIX_CONFIG.margin}`);
 
  // Precalentar cache de hoteles al arrancar — así el primer cliente no espera 5s.
  console.log('[STARTUP] Precalentando cache de hoteles...');
  const hotels = await getHotelsList();
  if (hotels) {
    const parks = [...new Set(hotels.map(h => h.parkType).filter(Boolean))];
    console.log(`[STARTUP] Cache lista: ${hotels.length} hoteles, parques: ${parks.join(', ') || '(ninguno con parkType)'}`);
  } else {
    console.warn('[STARTUP] No se pudo precalentar cache. /api/search funcionará solo por cityId.');
  }
});
