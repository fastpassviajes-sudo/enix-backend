const http = require('http');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const arrival = url.searchParams.get('arrival') || '2026-08-10';
  const departure = url.searchParams.get('departure') || '2026-08-17';
  const adults = url.searchParams.get('adults') || '2';
  const children = url.searchParams.get('children') || '1';

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soap:Header>
    <tem:AuthHeader>
      <tem:UserName>testnewXML</tem:UserName>
      <tem:Password>testnewXML2023$</tem:Password>
    </tem:AuthHeader>
  </soap:Header>
  <soap:Body>
    <tem:SearchHotel>
      <tem:arrival>${arrival}</tem:arrival>
      <tem:departure>${departure}</tem:departure>
      <tem:paxlist>
        <tem:adults>${adults}</tem:adults>
        <tem:child>${children}</tem:child>
        <tem:childage><tem:int>8</tem:int></tem:childage>
      </tem:paxlist>
    </tem:SearchHotel>
  </soap:Body>
</soap:Envelope>`;

  const options = {
    hostname: 'integrate.dev.enix.travel',
    path: '/Service_Parks.asmx',
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': 'http://tempuri.org/SearchHotel',
      'Content-Length': Buffer.byteLength(xml)
    }
  };

  const enixReq = http.request(options, (enixRes) => {
    let data = '';
    enixRes.on('data', (chunk) => data += chunk);
    enixRes.on('end', () => {
      res.end(JSON.stringify({ xml: data }));
    });
  });

  enixReq.on('error', (e) => {
    res.end(JSON.stringify({ error: e.message }));
  });

  enixReq.write(xml);
  enixReq.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
