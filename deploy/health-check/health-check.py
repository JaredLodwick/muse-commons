#!/usr/bin/env python3
"""Muse Commons external health check.

Hits the lobby's /api/health endpoint over HTTPS and reports service
status. Intended for cron (every 5 minutes is plenty).

Exit codes:
  0  OK — service healthy (and TLS front fine, if reported)
  1  CRITICAL — could not reach /api/health, non-200, or ok:false
  2  WARNING — service healthy but the HTTPS front's certificate is
     expired or expiring within the warn threshold (renew soon)

Usage:
  python3 health-check.py [--url URL]

Default URL is the HTTPS proxy front:
  https://jaredlodwick.design/muse/commons-api/api/health
"""
import argparse
import json
import sys
import urllib.request
import urllib.error

DEFAULT_URL = "https://jaredlodwick.design/muse/commons-api/api/health"
TIMEOUT = 20


def main():
    ap = argparse.ArgumentParser(description="Muse Commons health check")
    ap.add_argument("--url", default=DEFAULT_URL, help="full /api/health URL")
    args = ap.parse_args()

    try:
        req = urllib.request.Request(args.url, headers={"User-Agent": "muse-commons-health-check/1.0"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            if resp.status != 200:
                print(f"CRITICAL: {args.url} returned HTTP {resp.status}")
                return 1
            try:
                health = json.loads(resp.read().decode("utf-8"))
            except Exception as e:
                print(f"CRITICAL: {args.url} returned non-JSON: {e}")
                return 1
    except urllib.error.HTTPError as e:
        print(f"CRITICAL: {args.url} returned HTTP {e.code}")
        return 1
    except Exception as e:
        print(f"CRITICAL: cannot reach {args.url}: {e}")
        return 1

    if not isinstance(health, dict) or not health.get("ok"):
        print(f"CRITICAL: service reports unhealthy: {health!r}")
        return 1

    bits = [
        f"service={health.get('service', '?')}",
        f"protocol={health.get('protocol_version', '?')}",
        f"uptime={health.get('uptime_seconds', '?')}s",
        f"incident_mode={health.get('incident_mode', '?')}",
        f"agents={health.get('agents', '?')}",
    ]
    tls = health.get("tls") or {}
    if tls.get("ok") is False:
        print(
            "WARNING: service OK but TLS front certificate problem: "
            f"{tls.get('error', 'unknown')} "
            f"(host={tls.get('host')}, expires_in_days={tls.get('expires_in_days')}) | "
            + " ".join(bits)
        )
        return 2

    print("OK: " + " ".join(bits))
    return 0


if __name__ == "__main__":
    sys.exit(main())
