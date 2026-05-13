// =====================================================================
// MAGIC TRAVELERS - Backend ENIX + Claude AI v2
// SearchHotelAdvancedV1 con SOAP 1.2 sobre Service_Hotels.asmx
// + endpoints SOAP heredados sobre Service_Parks.asmx
// + endpoint /api/chat con Claude
// =====================================================================
 
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
 
const app = express();
app.use(express.json({ limit: '1mb' }));
 
// =====================================================================
// CORS
// =====================================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
 
// =====================================================================
// CONFIG
// =====================================================================
const ENIX_CONFIG = {
  // Servicio viejo (para GetHotelMaster - lista de hoteles Disney/Universal)
  parksEndpoint: process.env.ENIX_ENDPOINT || 'http://integrate.dev.enix.travel/Service_Parks.asmx',
 
  // Servicio nuevo (para SearchHotelAdvancedV1 - búsqueda con precios)
  hotelsEndpoint: process.env.ENIX_HOTELS_ENDPOINT || 'http://integratedev.fullofdreams.travel/Service_Hotels.asmx',
 
  username: process.env.ENIX_USERNAME || 'testnewXML',
  password: process.env.ENIX_PASSWORD || 'testnewXML2023$',
  namespace: 'http://tempuri.org/',
  margin: parseFloat(process.env.MAGIC_MARGIN || '1.10'),
 
  // Orlando city id (basado en cityid=729 de la lista de hoteles Disney/Universal)
  orlandoCityId: parseInt(process.env.ORLANDO_CITY_ID || '729'),
};
 
const MAGIC_CONFIG = {
  whatsappNumber: process.env.MAGIC_WHATSAPP || '5491121882210',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  claudeMaxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS || '2048'),
};
 
// Cliente Anthropic (lee ANTHROPIC_API_KEY del env)
const anthropic = new Anthropic();
 
// =====================================================================
// HELPERS XML
// =====================================================================
 
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
 
function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const matches = [];
  let m;
  while ((m = regex.exec(xml)) !== null) matches.push(m[1]);
  return matches;
}
 
function extractFirst(xml, tag) {
  const arr = extractTag(xml, tag);
  return arr.length > 0 ? arr[0] : null;
}
 
// =====================================================================
// SOAP 1.1 - para Service_Parks.asmx (GetHotelMaster)
// =====================================================================
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
 
// =====================================================================
// SOAP 1.2 - para Service_Hotels.asmx (SearchHotelAdvancedV1)
// IMPORTANTE: SOAP 1.2 usa namespace distinto y Content-Type application/soap+xml
// =====================================================================
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
        // SOAP 1.2 usa application/soap+xml, NO text/xml
        'Content-Type': `application/soap+xml; charset=utf-8; action="${ENIX_CONFIG.namespace}${methodName}"`,
      },
      timeout: 90000, // 90s - SearchHotelAdvancedV1 puede tardar varios segundos
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
 
// =====================================================================
// PARSERS
// =====================================================================
 
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
  }));
}
 
function parseSearchHotelAdvancedV1(xml) {
  // Parse Paging
  const totalRecords = parseInt(extractFirst(xml, 'TotalRecords') || '0');
  const totalPages = parseInt(extractFirst(xml, 'TotalPages') || '0');
  const pageSize = parseInt(extractFirst(xml, 'PageSize') || '0');
  const targetPage = parseInt(extractFirst(xml, 'TargetPage') || '0');
 
  // Cada Hotel viene con Rooms y cada Room con Options
  const hotels = extractTag(xml, 'Hotel');
  const parsedHotels = hotels.map(h => {
    const hotelId = extractFirst(h, 'Id');
    const name = (extractFirst(h, 'Name') || '').trim();
 
    // Habitaciones del hotel
    const rooms = extractTag(h, 'Room');
    const parsedRooms = rooms.map(r => {
      const roomType = (extractFirst(r, 'RoomType') || '').trim();
      const roomId = extractFirst(r, 'RoomID');
 
      // Opciones de tarifa para la habitación
      const options = extractTag(r, 'Option');
      const parsedOptions = options.map(opt => {
        const netNightsTotal = parseFloat(extractFirst(opt, 'OptionNightsTotal') || '0');
        const netTotal = parseFloat(extractFirst(opt, 'OptionNightsNetTotal') || extractFirst(opt, 'OptionNightsTotal') || '0');
        const finalPrice = Math.round(netNightsTotal * ENIX_CONFIG.margin * 100) / 100;
 
        return {
          optionId: extractFirst(opt, 'OptionID'),
          bookParam: extractFirst(opt, 'BookParam'),
          board: (extractFirst(opt, 'Board') || '').trim(),
          status: extractFirst(opt, 'OptionStatus'),
          rateType: extractFirst(opt, 'Type'),
          maxOccup: parseInt(extractFirst(opt, 'MaxOccup') || '0'),
          netPrice: netNightsTotal,           // Precio neto ENIX
          netTotal: netTotal,                  // Net total (sin comisión)
          finalPrice: finalPrice,              // Precio final con margen +10%
          currency: 'USD',
        };
      });
 
      return {
        roomType,
        roomId,
        options: parsedOptions,
      };
    });
 
    // Precio mínimo del hotel
    const allPrices = parsedRooms
      .flatMap(r => r.options.map(o => o.finalPrice))
      .filter(p => p > 0);
    const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : null;
 
    return {
      hotelId,
      name,
      rooms: parsedRooms,
      minPrice,
    };
  });
 
  return {
    totalRecords,
    totalPages,
    pageSize,
    targetPage,
    hotels: parsedHotels,
  };
}
 
// =====================================================================
// CACHE de hoteles (la lista cambia raras veces, la cacheamos 1h)
// =====================================================================
let hotelsCache = { data: null, timestamp: 0 };
const HOTELS_CACHE_TTL = 60 * 60 * 1000;
 
async function getHotelsList() {
  if (hotelsCache.data && Date.now() - hotelsCache.timestamp < HOTELS_CACHE_TTL) {
    return hotelsCache.data;
  }
  const result = await callEnixParks('GetHotelMaster');
  if (!result.success) return null;
  const hotels = parseHotelList(result.data);
  hotelsCache = { data: hotels, timestamp: Date.now() };
  return hotels;
}
 
// =====================================================================
// FUNCIÓN PRINCIPAL DE BÚSQUEDA - SearchHotelAdvancedV1
// =====================================================================
 
async function searchHotelsAdvanced({
  cityId = ENIX_CONFIG.orlandoCityId,
  arrival,
  departure,
  adults = 2,
  children = 0,
  childAges = [],
  qty = 1,
  hotelList = [],  // si está vacío, busca en toda la ciudad
  availableOnly = 1,
}) {
  // Formatear fechas a dateTime ISO
  // Si viene 'YYYY-MM-DD', agregamos T00:00:00
  const fmtDate = (d) => d.includes('T') ? d : `${d}T00:00:00`;
 
  const childAgesXml = childAges.length > 0
    ? `         <tem:childage>${childAges.map(a => `<tem:int>${parseInt(a)}</tem:int>`).join('')}</tem:childage>`
    : '';
 
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
 
  const result = await callEnixHotels('SearchHotelAdvancedV1', body);
  if (!result.success) return result;
 
  const parsed = parseSearchHotelAdvancedV1(result.data);
  return {
    success: true,
    ...parsed,
    margin: ENIX_CONFIG.margin,
    note: 'Los precios en finalPrice ya incluyen el margen del 10% de Magic Travelers',
  };
}
 
// =====================================================================
// ===== ENDPOINTS REST PÚBLICOS =======================================
// =====================================================================
 
app.get('/', (req, res) => {
  res.json({
    service: 'Magic Travelers Backend',
    status: 'OK',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET  /                       - este healthcheck',
      'GET  /api/hotels-list        - lista 35 hoteles Disney/Universal (JSON)',
      'POST /api/search             - búsqueda con precios (SearchHotelAdvancedV1)',
      'POST /api/chat               - chat IA con Claude (asesor)',
      'GET  /api/test-connection    - test viejo (XML crudo, mantiene compat)',
    ],
  });
});
 
app.get('/api/test-connection', async (req, res) => {
  const result = await callEnixParks('GetHotelMaster');
  res.json(result);
});
 
app.get('/api/hotels-list', async (req, res) => {
  const hotels = await getHotelsList();
  if (!hotels) return res.status(500).json({ success: false, error: 'No data' });
  res.json({ success: true, count: hotels.length, hotels });
});
 
// Búsqueda principal con SearchHotelAdvancedV1
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
    arrival,
    departure,
    adults,
    children,
    childAges,
    qty,
    hotelList,
    availableOnly,
  });
 
  res.json(result);
});
 
// =====================================================================
// ===== CLAUDE AI CHAT ================================================
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
    description: 'Devuelve la lista completa de hoteles oficiales Disney y Universal Orlando. Útil cuando el cliente pregunta qué hoteles hay disponibles, SIN necesidad de fechas. NO requiere fechas.',
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
        parque: {
          type: 'string',
          enum: ['Disney', 'Universal', 'All'],
          description: 'Disney, Universal o ambos. "All" busca en toda Orlando.',
        },
        check_in: { type: 'string', description: 'Fecha YYYY-MM-DD' },
        check_out: { type: 'string', description: 'Fecha YYYY-MM-DD' },
        adultos: { type: 'integer' },
        ninos: { type: 'integer' },
        edades_ninos: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Edades de los niños',
        },
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
          description: 'Resumen completo del paquete en primera persona desde el cliente.',
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
      if (!all) return { error: 'No pude obtener la lista de hoteles ahora.' };
      const filtered = toolInput.parque === 'All'
        ? all
        : all.filter(h => h.parkType === toolInput.parque);
      return {
        cantidad: filtered.length,
        hoteles: filtered.map(h => ({
          id: h.hotelId,
          nombre: h.name,
          parque: h.parkType,
        })),
      };
    }
 
    if (toolName === 'buscar_hoteles') {
      const { parque, check_in, check_out, adultos, ninos = 0, edades_ninos = [] } = toolInput;
 
      // Si el cliente quiere solo Disney o solo Universal, filtramos por hotelList
      let hotelList = [];
      if (parque === 'Disney' || parque === 'Universal') {
        const all = await getHotelsList();
        if (all) {
          hotelList = all.filter(h => h.parkType === parque).map(h => h.hotelId);
        }
      }
      // Si parque === 'All', dejamos hotelList vacío para buscar en toda Orlando
 
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
        return { error: 'No se pudo consultar disponibilidad. Derivá a WhatsApp.' };
      }
 
      if (result.totalRecords === 0 || result.hotels.length === 0) {
        return {
          aviso: 'Sin disponibilidad para esas fechas. NO le digas al cliente "no hay" — derivá a WhatsApp con generar_link_whatsapp con todos los datos.',
          cantidad: 0,
        };
      }
 
      // Limitar a 8 hoteles para no saturar contexto
      const topHotels = result.hotels
        .filter(h => h.minPrice > 0)
        .sort((a, b) => a.minPrice - b.minPrice)
        .slice(0, 8);
 
      return {
        total_disponibles: result.totalRecords,
        hoteles: topHotels.map(h => ({
          id: h.hotelId,
          nombre: h.name,
          precio_minimo_total_usd: h.minPrice,
          opciones_habitacion: h.rooms.slice(0, 3).map(r => ({
            tipo: r.roomType,
            tarifas: r.options.slice(0, 2).map(o => ({
              board: o.board,
              precio_total_usd: o.finalPrice,
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
 
      const total = precio_hotel_total + (incluye_tickets ? precio_tickets_total : 0) + (incluye_dining ? precio_dining_total : 0);
      const ahorroEstimado = Math.round(total * 0.25);
 
      return {
        desglose: {
          hotel: precio_hotel_total,
          tickets: incluye_tickets ? { tipo: tipo_tickets, precio: precio_tickets_total } : null,
          dining: incluye_dining ? { tipo: tipo_dining, precio: precio_dining_total } : null,
        },
        total_usd: Math.round(total),
        cantidad_personas,
        cantidad_noches,
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
 
  let history = messages.map(m => ({
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
        tools: tools,
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
app.listen(PORT, () => {
  console.log(`Magic Travelers backend v2 listening on port ${PORT}`);
  console.log(`Parks endpoint: ${ENIX_CONFIG.parksEndpoint}`);
  console.log(`Hotels endpoint: ${ENIX_CONFIG.hotelsEndpoint}`);
  console.log(`Claude model: ${MAGIC_CONFIG.claudeModel}`);
  console.log(`Margin: ${ENIX_CONFIG.margin}`);
  console.log(`Orlando cityId: ${ENIX_CONFIG.orlandoCityId}`);
});
