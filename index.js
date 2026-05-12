// =====================================================================
// MAGIC TRAVELERS - Backend ENIX (Render.com)
// Conecta con ENIX usando el AuthHeader correcto
// =====================================================================

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// =====================================================================
// CONFIGURACIÓN ENIX (desde variables de entorno)
// =====================================================================
const ENIX_CONFIG = {
  endpoint: process.env.ENIX_ENDPOINT || 'http://integrate.dev.enix.travel/Service_Parks.asmx',
  username: process.env.ENIX_USERNAME || 'testnewXML',
  password: process.env.ENIX_PASSWORD || 'testnewXML2023$',
  namespace: 'http://tempuri.org/'
};

// =====================================================================
// HELPER: Escapa caracteres XML especiales
// =====================================================================
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// =====================================================================
// HELPER: Arma el SOAP envelope con AuthHeader de ENIX
// =====================================================================
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

// =====================================================================
// HELPER: Llama a un método SOAP de ENIX
// =====================================================================
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
        timeout: 30000,
      }
    );

    return {
      success: true,
      status: response.status,
      data: response.data,
    };
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
// ENDPOINTS
// =====================================================================

// Healthcheck — verifica que el server esté vivo
app.get('/', (req, res) => {
  res.send('Magic Travelers ENIX Backend OK - ' + new Date().toISOString());
});

// Test de conexión a ENIX — devuelve lista de hoteles Disney/Universal
app.get('/api/test-connection', async (req, res) => {
  const result = await callEnix('GetHotelMaster');
  res.json(result);
});

// =====================================================================
// ARRANQUE DEL SERVIDOR
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Magic Travelers backend listening on port ${PORT}`);
  console.log(`ENIX endpoint: ${ENIX_CONFIG.endpoint}`);
});
