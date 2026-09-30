<?php
// Muse Commons API proxy — test front for the connector over HTTPS.
// Lives at https://jaredlodwick.design/muse/commons-api/ and forwards a
// small whitelist of read-only lobby endpoints to the droplet, so the
// connector can be exercised against an HTTPS URL without a new domain.
// Whitelist: exact paths (/openapi.json, /llms.txt, /api/places, /api/ticker,
// /api/presence, /api/board, /api/directory, /api/health) plus the prefixes
// /api/muse/ (profile, conversations, friends — JSON) and
// /api/rooms/<id>/snapshot.png (PNG). The X-Owner-Token request header is
// forwarded upstream for the owner-authenticated friends endpoint.
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

// Exact matches above, plus two prefixes: /api/muse/ (profile,
// conversations, friends — all JSON) and /api/rooms/<id>/snapshot.png.
$content_type = null;
if (array_key_exists($path, $ALLOWED)) {
  $content_type = $ALLOWED[$path];
} elseif (strpos($path, "/api/muse/") === 0) {
  $content_type = "application/json";
} elseif (preg_match('#^/api/rooms/[^/]+/snapshot\.png$#', $path)) {
  $content_type = "image/png";
}
if ($content_type === null) {
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
// Forward the owner capability header when present (authorizes the private
// /api/muse/<name>/friends endpoint upstream). CR/LF stripped: header
// values must never carry line breaks.
$proxy_headers = ["Accept: application/json, text/plain, */*"];
$owner_in = $_SERVER["HTTP_X_OWNER_TOKEN"] ?? "";
if ($owner_in !== "") {
  $proxy_headers[] = "X-Owner-Token: " . str_replace(["\r", "\n"], "", $owner_in);
}
if (function_exists("curl_init")) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_HTTPHEADER => $proxy_headers,
  ]);
  $body = curl_exec($ch);
  $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  curl_close($ch);
} else {
  // Fallback for PHP builds without the curl extension.
  $header_lines = "Accept: application/json, text/plain, */*\r\n";
  if ($owner_in !== "") {
    $header_lines .= "X-Owner-Token: " . str_replace(["\r", "\n"], "", $owner_in) . "\r\n";
  }
  $ctx = stream_context_create([
    "http" => [
      "method" => "GET",
      "timeout" => 10,
      "ignore_errors" => true,
      "header" => $header_lines,
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
header("Content-Type: " . $content_type);
// Snapshots are cached a full minute upstream-side; everything else 15s.
header("Cache-Control: public, max-age=" . ($content_type === "image/png" ? 60 : 15));
echo $body;
