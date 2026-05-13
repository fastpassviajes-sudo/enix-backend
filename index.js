// =====================================================================
// MAGIC TRAVELERS - Backend ENIX + Claude AI
// Endpoints SOAP a ENIX + endpoint /api/chat con Claude Sonnet 4.6
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
  endpoint: process.env.ENIX_ENDPOINT || 'http://integrate.dev.enix.travel/Service_Parks.asmx',
  username: process.env.ENIX_USERNAME || 'testnewXML',
  password: process.env.ENIX_PASSWORD || 'testnewXML2023$',
  namespace: 'http://tempuri.org/',
  margin: parseFloat(process.env.MAGIC_MARGIN || '1.10'),
};
 
const MAGIC_CONFIG = {
  whatsappNumber: process.env.MAGIC_WHATSAPP || '5491121882210',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  claudeMaxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS || '2048'),
};
 
// Cliente Anthropic (lee ANTHROPIC_API_KEY del env automáticamente)
const anthropic = new Anthropic();
 
// =====================================================================
// HELPERS SOAP/XML
// =====================================================================
 
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}
 
async function callEnix(methodName, bodyContent = '') {
  const soapBody = buildSoapEnvelope(methodName, bodyContent);
  try {
    const response = await axios.post(ENIX_CONFIG.endpoint, soapBody, {
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
 
function parseSearchResults(xml) {
  const hotels = extractTag(xml, 'Hotel');
  return hotels.map(h => {
    const options = extractTag(h, 'Option').map(opt => {
      const netPrice = parseFloat(extractFirst(opt, 'total')) || 0;
      const finalPrice = Math.round(netPrice * ENIX_CONFIG.margin * 100) / 100;
      return {
        optionId: extractFirst(opt, 'optionid'),
        roomType: (extractFirst(opt, 'roomtype') || '').trim(),
        mealPlan: (extractFirst(opt, 'mealplan') || '').trim(),
        netPrice,
        finalPrice,
        currency: extractFirst(opt, 'currency') || 'USD',
      };
    });
    return {
      hotelId: extractFirst(h, 'hotelid'),
      name: (extractFirst(h, 'name') || '').trim(),
      parkType: extractFirst(h, 'ParkType'),
      options,
      minPrice: options.length > 0 ? Math.min(...options.map(o => o.finalPrice)) : null,
    };
  });
}
 
// =====================================================================
// CACHE de hoteles (la lista cambia raras veces, la cacheamos 1h)
// =====================================================================
let hotelsCache = { data: null, timestamp: 0 };
const HOTELS_CACHE_TTL = 60 * 60 * 1000; // 1 hora
 
async function getHotelsList() {
  if (hotelsCache.data && Date.now() - hotelsCache.timestamp < HOTELS_CACHE_TTL) {
    return hotelsCache.data;
  }
  const result = await callEnix('GetHotelMaster');
  if (!result.success) return null;
  const hotels = parseHotelList(result.data);
  hotelsCache = { data: hotels, timestamp: Date.now() };
  return hotels;
}
 
// =====================================================================
// ===== ENDPOINTS REST (igual que antes) ==============================
// =====================================================================
 
app.get('/', (req, res) => {
  res.json({
    service: 'Magic Travelers Backend',
    status: 'OK',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET  /                  - este healthcheck',
      'GET  /api/test-connection - lista de hoteles (XML crudo)',
      'GET  /api/hotels-list   - lista de hoteles JSON',
      'POST /api/search        - buscar hoteles con fechas y huéspedes',
      'GET  /api/hotel-data/:id - detalle hotel',
      'POST /api/chat          - chat IA con Claude (asesor)',
    ],
  });
});
 
app.get('/api/test-connection', async (req, res) => {
  const result = await callEnix('GetHotelMaster');
  res.json(result);
});
 
app.get('/api/hotels-list', async (req, res) => {
  const hotels = await getHotelsList();
  if (!hotels) return res.status(500).json({ success: false, error: 'No data' });
  res.json({ success: true, count: hotels.length, hotels });
});
 
app.post('/api/search', async (req, res) => {
  const { type = 'All', arrival, departure, adults = 2, children = 0, childAges = [] } = req.body;
  if (!arrival || !departure) {
    return res.status(400).json({ success: false, error: 'arrival y departure son requeridos' });
  }
  if (!['Disney', 'Universal', 'All'].includes(type)) {
    return res.status(400).json({ success: false, error: 'type debe ser Disney, Universal o All' });
  }
  const childAgesXml = childAges.length > 0
    ? `<childage>${childAges.map(a => `<int>${parseInt(a)}</int>`).join('')}</childage>` : '';
  const bodyXml = `
    <type>${type}</type><arrival>${arrival}</arrival><departure>${departure}</departure>
    <paxlist><adults>${parseInt(adults)}</adults><child>${parseInt(children)}</child>${childAgesXml}</paxlist>
  `.trim();
  const result = await callEnix('SearchHotel', bodyXml);
  if (!result.success) return res.status(500).json(result);
  const hotels = parseSearchResults(result.data);
  res.json({ success: true, query: { type, arrival, departure, adults, children, childAges }, count: hotels.length, hotels });
});
 
app.get('/api/hotel-data/:hotelId', async (req, res) => {
  const hotelId = parseInt(req.params.hotelId);
  if (!hotelId) return res.status(400).json({ success: false, error: 'hotelId inválido' });
  const result = await callEnix('GetHotelData', `<hotelid>${hotelId}</hotelid>`);
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
- Sos experto en Disney y Universal: conocés los hoteles, los tickets, dining plans, mejores épocas, edades recomendadas, etc.
 
# Cómo trabajás
1. Saludá brevemente y preguntá qué necesita.
2. Hacé preguntas cortas para entender: destino (Disney/Universal/ambos), fechas, cantidad de adultos y niños (con edades), presupuesto si lo menciona.
3. Cuando tengas la información clave, usá la tool \`buscar_hoteles\` para ver disponibilidad real con precios.
4. Mostrá 2-3 opciones que se ajusten al perfil del cliente (no abrumes con la lista entera de 35 hoteles).
5. Si pregunta por tickets/dining, usá \`calcular_paquete\` para sumar al hotel.
6. Cuando el cliente esté listo, usá \`generar_link_whatsapp\` para pasarlo a un humano que cierre la venta.
 
# Reglas críticas que NUNCA rompas
- NUNCA inventes precios. Si una tool no devuelve precio, decí "déjame consultarlo y un asesor humano te confirma por WhatsApp" y usá \`generar_link_whatsapp\`.
- Los precios que devuelven las tools YA TIENEN el margen del 10% incluido. Mostralos tal cual, sin sumarles nada.
- NUNCA prometas disponibilidad que no validaste con \`buscar_hoteles\`.
- Si el cliente pregunta por destinos que NO son Disney/Universal Orlando, decile amablemente que en chat solo manejás esos dos, y derivalo a WhatsApp para asesoría general.
- Si NO podés ayudar (consultas técnicas, quejas, devoluciones, casos complejos), pasalo a WhatsApp con \`generar_link_whatsapp\`.
 
# Sobre el entorno actual (importante)
- El sistema de búsqueda en tiempo real (\`buscar_hoteles\`) está en modo prueba: puede devolver "sin resultados" aunque haya disponibilidad real. Si pasa eso, NO le digas al cliente que no hay disponibilidad. Decile algo como "déjame que un asesor confirme la disponibilidad y precio exacto, te paso a WhatsApp" y usá la tool \`generar_link_whatsapp\` con los datos que tengas.
- La tool \`listar_hoteles\` SÍ funciona perfecto y trae los 35 hoteles oficiales Disney/Universal que comercializamos.
 
# Información útil para conversaciones
- Hoteles Disney por categoría:
  * Value (~$130-180/noche): All Star Movies, All Star Music, All Star Sports, Pop Century, Art of Animation
  * Moderate (~$200-280/noche): Caribbean Beach, Port Orleans (French Quarter y Riverside), Coronado Springs
  * Deluxe (~$450-700/noche): Contemporary, Grand Floridian, Polynesian, Wilderness Lodge, Animal Kingdom Lodge, Beach Club, Yacht Club, BoardWalk, Riviera
- Hoteles Universal:
  * Prime Value (~$140-180/noche): Endless Summer Dockside, Endless Summer Surfside
  * Prime Value Plus (~$200-240/noche): Cabana Bay Beach Resort, Aventura Hotel
  * Preferred (~$280-340/noche): Sapphire Falls
  * Premier (~$380-500/noche, incluyen Express Pass Unlimited gratis): Royal Pacific, Hard Rock, Portofino Bay
- Mejor época Disney: enero-febrero (low season), mayo, septiembre-octubre. Evitar: vacaciones americanas (Spring Break, Thanksgiving, Christmas) por colas y precios altos.
- Disney 4-Park Magic Ticket es la promo más usada de verano, da acceso a los 4 parques una vez.
- Magic Travelers cobra 10% de margen sobre las tarifas Ticketland/ENIX, y aún así sale ~25% más barato que comprar directo a Disney.
 
Sé útil, sé conciso, y siempre que dudes derivá a WhatsApp humano. No estás solo: hay un equipo real atrás listo para cerrar la venta.`;
 
// =====================================================================
// TOOLS — Las "manos" de Claude
// =====================================================================
 
const tools = [
  {
    name: 'listar_hoteles',
    description: 'Devuelve la lista completa de hoteles oficiales Disney y Universal Orlando que Magic Travelers comercializa. Útil cuando el cliente pregunta qué hoteles hay disponibles, sin necesidad de fechas específicas. NO requiere fechas.',
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
    description: 'Busca disponibilidad real de hoteles con precios para fechas específicas y cantidad de huéspedes. ÚSALA cuando ya tengas fechas y cantidad de personas confirmadas. Los precios devueltos ya incluyen el margen de 10% de Magic Travelers.',
    input_schema: {
      type: 'object',
      properties: {
        parque: {
          type: 'string',
          enum: ['Disney', 'Universal', 'All'],
          description: 'Disney, Universal o ambos',
        },
        check_in: {
          type: 'string',
          description: 'Fecha de check-in en formato YYYY-MM-DD',
        },
        check_out: {
          type: 'string',
          description: 'Fecha de check-out en formato YYYY-MM-DD',
        },
        adultos: { type: 'integer', description: '10+ años' },
        ninos: { type: 'integer', description: '3 a 9 años' },
        edades_ninos: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Lista de edades de los niños',
        },
      },
      required: ['parque', 'check_in', 'check_out', 'adultos'],
    },
  },
  {
    name: 'calcular_paquete',
    description: 'Calcula el precio total de un paquete sumando hotel + tickets + dining plan. Usá los precios estimados de tickets y dining que conocés. Devuelve un desglose claro con el total final.',
    input_schema: {
      type: 'object',
      properties: {
        precio_hotel_total: {
          type: 'number',
          description: 'Precio total del hotel (ya con margen incluido)',
        },
        cantidad_personas: { type: 'integer' },
        cantidad_noches: { type: 'integer' },
        incluye_tickets: { type: 'boolean' },
        tipo_tickets: {
          type: 'string',
          description: 'Ej: "Disney 4-Park Magic 4 días" o "Universal Park to Park 3 días"',
        },
        precio_tickets_total: { type: 'number', description: 'Precio total de tickets si aplica' },
        incluye_dining: { type: 'boolean' },
        tipo_dining: {
          type: 'string',
          description: 'Ej: "Quick Service" o "Disney Dining Plan"',
        },
        precio_dining_total: { type: 'number' },
      },
      required: ['precio_hotel_total', 'cantidad_personas', 'cantidad_noches'],
    },
  },
  {
    name: 'generar_link_whatsapp',
    description: 'Genera un link de WhatsApp listo para que el cliente lo toque y siga la conversación con un asesor humano. Incluí en el resumen todos los datos que ya hayas recolectado: nombre, fechas, hoteles vistos, precios, tickets, lo que pidió, etc.',
    input_schema: {
      type: 'object',
      properties: {
        resumen: {
          type: 'string',
          description: 'Mensaje completo que se va a pre-cargar en WhatsApp. Escribilo en primera persona desde el cliente, ej: "Hola, hablé con el asesor IA y quiero seguir con esto: ..."',
        },
        idioma: {
          type: 'string',
          enum: ['es', 'en', 'pt'],
          description: 'Idioma del mensaje',
        },
      },
      required: ['resumen'],
    },
  },
];
 
// =====================================================================
// EJECUTORES DE TOOLS — el código que corre cuando Claude pide una tool
// =====================================================================
 
async function executeTool(toolName, toolInput) {
  console.log(`[TOOL] ${toolName}`, JSON.stringify(toolInput));
 
  try {
    if (toolName === 'listar_hoteles') {
      const all = await getHotelsList();
      if (!all) return { error: 'No pude obtener la lista de hoteles ahora mismo.' };
      const filtered = toolInput.parque === 'All'
        ? all
        : all.filter(h => h.parkType === toolInput.parque);
      return {
        cantidad: filtered.length,
        hoteles: filtered.map(h => ({
          id: h.hotelId,
          nombre: h.name,
          parque: h.parkType,
          direccion: h.address,
        })),
      };
    }
 
    if (toolName === 'buscar_hoteles') {
      const { parque, check_in, check_out, adultos, ninos = 0, edades_ninos = [] } = toolInput;
      const childAgesXml = edades_ninos.length > 0
        ? `<childage>${edades_ninos.map(a => `<int>${parseInt(a)}</int>`).join('')}</childage>` : '';
      const bodyXml = `
        <type>${parque}</type><arrival>${check_in}</arrival><departure>${check_out}</departure>
        <paxlist><adults>${parseInt(adultos)}</adults><child>${parseInt(ninos)}</child>${childAgesXml}</paxlist>
      `.trim();
      const result = await callEnix('SearchHotel', bodyXml);
      if (!result.success) {
        return { error: 'No se pudo consultar disponibilidad en este momento. Pasá al cliente a WhatsApp.' };
      }
      const hotels = parseSearchResults(result.data);
      if (hotels.length === 0) {
        return {
          aviso: 'El sistema de búsqueda en modo prueba no devolvió resultados. NO le digas al cliente que no hay disponibilidad. En su lugar, derivalo a WhatsApp con generar_link_whatsapp incluyendo todos los datos que ya tengas.',
          cantidad: 0,
          hoteles: [],
        };
      }
      return {
        cantidad: hotels.length,
        nota: 'Los precios devueltos ya incluyen el margen de 10% de Magic Travelers. NO sumes nada extra.',
        hoteles: hotels.slice(0, 8),
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
        nota: 'Precios finales para mostrar al cliente. Ya incluyen margen Magic Travelers.',
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
      return { url, message_preview: fullMessage.slice(0, 200) };
    }
 
    return { error: `Tool desconocida: ${toolName}` };
  } catch (e) {
    console.error('[TOOL ERROR]', toolName, e.message);
    return { error: `Error ejecutando ${toolName}: ${e.message}` };
  }
}
 
// =====================================================================
// ENDPOINT /api/chat
// =====================================================================
 
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
  console.log(`Magic Travelers backend listening on port ${PORT}`);
  console.log(`ENIX endpoint: ${ENIX_CONFIG.endpoint}`);
  console.log(`Claude model: ${MAGIC_CONFIG.claudeModel}`);
  console.log(`Margin: ${ENIX_CONFIG.margin}`);
});
