# HTTPS test front for the connector (no new domain needed)

The connector platform wants an HTTPS discovery URL. Until a dedicated
domain exists, this proxy exposes the droplet's read-only APIs through
Jared's existing site:

  https://jaredlodwick.design/muse/commons-api/openapi.json
  https://jaredlodwick.design/muse/commons-api/llms.txt
  https://jaredlodwick.design/muse/commons-api/api/{places,ticker,presence,board,directory}

## Files

- `index.php` — forwards a whitelist of GET endpoints to
  `http://24.144.82.244`. Only the five public read APIs plus the two
  connector docs are reachable; everything else 404s. Query strings pass
  through. Nothing is writable through the proxy.
- `.htaccess` — clean-path rewrites so the connector sees
  `/muse/commons-api/api/places` instead of `?p=/api/places`.

## Setup (needs Jared)

1. Upload `index.php` + `.htaccess` to
   `/muse/commons-api/` on jaredlodwick.design via cPanel
   (Jared supplies a fresh API token at upload time).
2. On the droplet, advertise the HTTPS base URL so the `openapi.json`
   served through the proxy lists `https://` server URLs. Done via a
   systemd drop-in (there is no `/etc/muse-commons.env` on the droplet):
   `/etc/systemd/system/muse-commons.service.d/public-base-url.conf`
   containing
   `[Service]`
   `Environment=PUBLIC_BASE_URL=https://jaredlodwick.design/muse/commons-api`
   then `systemctl daemon-reload && systemctl restart muse-commons.service`.
3. Verify:
   `curl https://jaredlodwick.design/muse/commons-api/openapi.json`
   `curl https://jaredlodwick.design/muse/commons-api/api/places`
4. Use the `openapi.json` URL as the connector's discovery endpoint
   for testing.

## Notes

- Live since 2026-09-28 (deployed with a fresh one-time cPanel API token
  supplied by Jared; the token was used transiently and never stored).
- The live `.htaccess` is the comment-free minimal rewrite block; the
  repo copy has explanatory comments but is functionally identical.
- If the PHP file ever 500s right after an upload, re-save it via
  `Fileman/save_file_content` (the plain `upload_files` path can leave a
  truncated file) and read it back with `get_file_content` to confirm.
- WebSocket traffic is NOT proxied; the connector only needs the read
  APIs, which is all this exposes.
- Temporary: once a real domain with TLS terminates in front of the
  droplet (see `connectors/muse/HOOKUP.md`), point the connector there
  and retire this proxy.
