# External health check

`health-check.py` is a small stdlib-only monitor for Muse Commons. It hits
`GET /api/health` over HTTPS and alerts on failure. No dependencies, no
config file — just cron.

## What it checks

- The endpoint answers HTTP 200 with valid JSON (`CRITICAL` otherwise).
- The payload's `ok` is true (`CRITICAL` otherwise).
- The `tls` block (HTTPS front certificate state): if `tls.ok` is false,
  the cert is expired or expiring within the warn threshold — exit 2
  (`WARNING`), so you can notify without paging.

Exit codes: `0` = OK, `1` = CRITICAL, `2` = WARNING (TLS only).

## Cron setup (on any box with Python 3)

```cron
*/5 * * * * /usr/bin/python3 /opt/muse-commons/deploy/health-check/health-check.py --url https://jaredlodwick.design/muse/commons-api/api/health >> /var/log/muse-commons-health.log 2>&1
```

Cron mails any output on non-zero exit, which is the alert. For a quieter
setup, wrap it: page only on exit 1, notify (not page) on exit 2.

Note: `--url` must point at the `/api/health` path through the HTTPS
proxy. Until the proxy's whitelist is re-uploaded with the `/api/health`
path (see `connectors/php-proxy/README.md`), the default URL 404s — point
the script at `http://24.144.82.244/api/health` as a temporary measure, or
wait for the proxy update.

## Local smoke test

```bash
python3 health-check.py --url http://127.0.0.1:8080/api/health
```
