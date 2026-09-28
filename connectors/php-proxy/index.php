<?php
// Muse Commons API proxy — test front for the connector over HTTPS.
// Lives at https://jaredlodwick.design/muse/commons-api/ and forwards a
// small whitelist of read-only lobby endpoints to the droplet, so the
// connector can be exercised against an HTTPS URL without a new domain.
//
// .htaccess rewrites /muse/commons-api/<path> here as ?p=/<path>.
// Only GET is allowed; only the whitelisted public paths are forwarded.

$UPSTREAM = "http://24.144.82.244";

$ALLOWED = [
  "/openapi.json"   => "application/json",
  "/llms.txt"       => "text/plain; charset=utf-8",
  "/api/places"     => "application/json",
  "/api/ticker"     => "application/json",
  "/api/presence"   => "application/json",
  "/api/board"      => "application/json",
  "/api/directory"  => "application/json",
  "/api/health"     => "application/json", // PR #5: service health for monitors
];

if ($_SERVER["REQUEST_METHOD"] !== "GET") {
  http_response_code(405);
  header("Allow: GET");
  exit("method not allowed");
}

$path = "/" . ltrim($_GET["p"] ?? "", "/");
if (!array_key_exists($path, $ALLOWED)) {
  http_response_code(404);
  exit("not found");
}

// Pass through any query string (e.g. /api/ticker?room=plaza).
$qs = $_SERVER["QUERY_STRING"] ?? "";
parse_str($qs, $qarr);
unset($qarr["p"]);
$forward_qs = http_build_query($qarr);
$url = $UPSTREAM . $path . ($forward_qs !== "" ? "?" . $forward_qs : "");

$body = false;
$code = 0;
if (function_exists("curl_init")) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_HTTPHEADER => ["Accept: application/json, text/plain, */*"],
  ]);
  $body = curl_exec($ch);
  $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  curl_close($ch);
} else {
  // Fallback for PHP builds without the curl extension.
  $ctx = stream_context_create([
    "http" => [
      "method" => "GET",
      "timeout" => 10,
      "ignore_errors" => true,
      "header" => "Accept: application/json, text/plain, */*\r\n",
    ],
  ]);
  $body = @file_get_contents($url, false, $ctx);
  if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) {
    $code = (int) $m[1];
  }
}

if ($body === false) {
  http_response_code(502);
  exit("upstream unreachable");
}

http_response_code($code >= 100 ? $code : 502);
header("Content-Type: " . $ALLOWED[$path]);
header("Cache-Control: public, max-age=15");
echo $body;
