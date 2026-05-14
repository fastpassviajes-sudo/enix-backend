// =====================================================================
// MAGIC TRAVELERS - Backend ENIX + Claude AI v3 (VERSIÓN PREVIA)
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
// HELPERS XML
// ---------------------------------------------------------------------
function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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
// SOAP LOGIC
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

function buildSoap12(methodName, bodyContent = '') {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tem="http://tempuri.org/">
  <soap:Header>
    <tem:AuthHeader>
      <tem:Username>${escapeXml(ENIX_CONFIG.username)}</tem:Username>
      <tem:Password>${escapeXml(ENIX_CONFIG.password)}</tem:Password>
    </tem:AuthHeader>
  </soap:Header>
  <soap:Body><tem:${methodName}>${bodyContent}</tem:${methodName}></soap:Body>
</soap:Envelope>`;
}

async function callEnixParks(methodName, bodyContent = '') {
  const soapBody = buildSoap11(methodName, bodyContent);
  try {
    const response = await axios.post(ENIX_CONFIG.parksEndpoint, soapBody, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `"${ENIX_CONFIG.namespace}${methodName}"` },
      timeout: 60000,
    });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function callEnixHotels(methodName, bodyContent = '') {
  const soapBody = buildSoap12(methodName, bodyContent);
  try {
    const response = await axios.post(ENIX_CONFIG.hotelsEndpoint, soapBody, {
      headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${ENIX_CONFIG.namespace}${methodName}"` },
      timeout: 90000,
    });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
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
    parkType: extractFirst(h, 'ParkType') || extractFirst(h, 'parktype') || null,
  })).filter(h => h.hotelId);
}

function parseSearchHotelAdvancedV1(xml) {
  const hotels = extractTagAll(xml, 'Hotel');
  const parsedHotels = hotels.map(h => {
    const hotelId = extractFirst(h, 'Id');
    const name = (extractFirst(h, 'Name') || '').trim();
    const rooms = extractTagAll(h, 'Room');
    const parsedRooms = rooms.map(r => {
      const options = extractTagAll(r, 'Option');
      const parsedOptions = options.map(opt => {
        const netNightsTotal = parseFloat(extractFirst(opt, 'OptionNightsTotal') || '0');
        return {
          optionId: extractFirst(opt, 'OptionID') || extractFirst(opt, 'OptionId'),
          bookParam: extractFirst(opt, 'BookParam'),
          board: (extractFirst(opt, 'Board') || '').trim(),
          finalPrice: Math.round(netNightsTotal * ENIX_CONFIG.margin * 100) / 100,
          currency: 'USD',
        };
      });
      return { roomType: (extractFirst(r, 'RoomType') || '').trim(), options: parsedOptions };
    });
    const minPrice = Math.min(...parsedRooms.flatMap(r => r.options.map(o => o.finalPrice)).filter(p => p > 0));
    return { hotelId, name, rooms: parsedRooms, minPrice: isFinite(minPrice) ? minPrice : null };
  });
  return { totalRecords: hotels.length, hotels: parsedHotels };
}

// ---------------------------------------------------------------------
// CACHE & CORE
// ---------------------------------------------------------------------
let hotelsCache = { data: null, timestamp: 0 };

async function getHotelsList() {
  if (hotelsCache.data && Date.now() - hotelsCache.timestamp < 3600000) return hotelsCache.data;
  const body = `<countryId>${ENIX_CONFIG.usaCountryId}</countryId><cityid>${ENIX_CONFIG.orlandoCityId}</cityid><zoneid>${ENIX_CONFIG.orlandoZoneId}</zoneid>`;
  const result = await callEnixParks('GetHotelMaster', body);
  if (result.success) {
    hotelsCache = { data: parseHotelMasterList(result.data), timestamp: Date.now() };
  }
  return hotelsCache.data;
}

async function searchHotelsAdvanced({ cityId = ENIX_CONFIG.orlandoCityId, arrival, departure, adults = 2, children = 0, childAges = [], hotelList = [] }) {
  const fmtDate = (d) => (d.includes('T') ? d : `${d}T00:00:00`);
  const childAgesXml = childAges.map(a => `<tem:int>${parseInt(a)}</tem:int>`).join('');
  const hotelListXml = hotelList.map(id => `<tem:int>${parseInt(id)}</tem:int>`).join('');

  const body = `
      <tem:cityid>${parseInt(cityId)}</tem:cityid>
      <tem:arrival>${fmtDate(arrival)}</tem:arrival>
      <tem:departure>${fmtDate(departure)}</tem:departure>
      <tem:qty>1</tem:qty>
      <tem:paxlist>
         <tem:adults>${parseInt(adults)}</tem:adults>
         <tem:child>${parseInt(children)}</tem:child>
         <tem:childage>${childAgesXml}</tem:childage>
      </tem:paxlist>
      <tem:availableonly>1</tem:availableonly>
      <tem:hotellist>${hotelListXml}</tem:hotellist>`;

  const result = await callEnixHotels('SearchHotelAdvancedV1', body);
  if (!result.success) return result;
  return { success: true, ...parseSearchHotelAdvancedV1(result.data), searchedBy: hotelList.length > 0 ? 'hotelList' : 'cityId' };
}

// ---------------------------------------------------------------------
// ENDPOINTS
// ---------------------------------------------------------------------
app.get('/api/diag', (req, res) => {
  res.json({ cacheCount: hotelsCache.data?.length || 0, config: ENIX_CONFIG });
});

app.post('/api/search', async (req, res) => {
  const result = await searchHotelsAdvanced(req.body);
  res.json(result);
});

// Endpoint /api/chat (Igual a como estaba antes)

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Magic Travelers backend v3 listening on port ${PORT}`);
  await getHotelsList();
});
