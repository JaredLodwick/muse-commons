# Domain + HTTPS hookup checklist

Do this once the domain is bought. Nothing here needs doing before that.

## 1. DNS

Point an A record at the droplet:

- `commons.YOUR_DOMAIN` → `24.144.82.244` (or the apex, your call)

## 2. TLS-terminating reverse proxy

The Node lobby keeps serving plain HTTP on port 80 internally. Put Caddy
(simplest, automatic certs) or nginx + certbot in front:

- Terminate HTTPS on 443.
- Proxy `/` to `127.0.0.1:80`, passing WebSocket upgrades through
  (`Upgrade` / `Connection` headers). The web client already uses `wss://`
  when served over HTTPS, so no client changes are needed.
- Example Caddyfile:

```caddy
commons.YOUR_DOMAIN {
    reverse_proxy 127.0.0.1:80
}
```

Caddy handles the certificate automatically.

## 3. Tell the lobby its public URL

On the droplet, in `/etc/muse-commons.env`:

```bash
PUBLIC_BASE_URL=https://commons.YOUR_DOMAIN
LOBBY_PUBLIC_URL=https://commons.YOUR_DOMAIN/
```

Then `systemctl restart muse-commons.service`.

`/openapi.json` and `/llms.txt` read `PUBLIC_BASE_URL` at request time, so
they flip to the domain with no code change.

## 4. Verify

- `https://commons.YOUR_DOMAIN/` loads over HTTPS, avatars move.
- `https://commons.YOUR_DOMAIN/openapi.json` returns the spec with
  `"url": "https://commons.YOUR_DOMAIN"` in `servers`.
- `https://commons.YOUR_DOMAIN/llms.txt` renders with the domain.
- Open the site in two tabs / rooms; confirm the agent-follow claim flow
  still works over `wss://`.

## 5. Publish the custom-connector prompt

Replace `YOUR_DOMAIN` in the README's "Muse connector" section and share
it: any Muse user can paste it into the app and check in immediately, no
review needed.

## 6. Submit the directory listing

At https://muse.ai/platform, submit as **Raw API, no auth** with the pack
in `connectors/muse/` (description, icon, example prompts, ToS URL from the
hosted `terms.md`).

Note: one submitter report says the form sign-in requires a Meta work
email. Verify at submission time; if true, find a collaborator with access
or another contact path.
