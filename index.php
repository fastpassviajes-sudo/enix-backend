<?php
header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json');

$arrival = isset($_GET['arrival']) ? $_GET['arrival'] : '2026-08-10';
$departure = isset($_GET['departure']) ? $_GET['departure'] : '2026-08-17';
$adults = isset($_GET['adults']) ? (int)$_GET['adults'] : 2;
$children = isset($_GET['children']) ? (int)$_GET['children'] : 0;
$type = isset($_GET['type']) ? (int)$_GET['type'] : 1;

$xml = '<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <AuthHeader xmlns="http://tempuri.org/">
      <UserName>testnewXML</UserName>
      <Password>testnewXML2023$</Password>
    </AuthHeader>
  </soap:Header>
  <soap:Body>
    <SearchHotel xmlns="http://tempuri.org/">
      <type>'.$type.'</type>
      <arrival>'.$arrival.'</arrival>
      <departure>'.$departure.'</departure>
      <paxlist>
        <adults>'.$adults.'</adults>
        <child>'.$children.'</child>
      </paxlist>
    </SearchHotel>
  </soap:Body>
</soap:Envelope>';

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, 'http://integrate.dev.enix.travel/Service_Parks.asmx');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $xml);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: text/xml; charset=utf-8',
    'SOAPAction: "http://tempuri.org/SearchHotel"'
]);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);

$response = curl_exec($ch);
$error = curl_error($ch);
curl_close($ch);

if ($error) {
    echo json_encode(['error' => $error]);
} else {
    echo json_encode(['xml' => $response]);
}
?>
