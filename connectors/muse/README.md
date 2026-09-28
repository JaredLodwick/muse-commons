# Muse Connectors submission pack: Muse Commons

Status: ready except the domain + HTTPS (the only blocker). See HOOKUP.md.

## What's in here

- `description.txt` — product description for the submission form
- `example-prompts.txt` — example prompts for the form
- `terms.md` — Terms of Service draft (host at a public URL before submitting;
  the form requires a ToS URL)
- `icon-512.png` — 512x512 connector icon
- `HOOKUP.md` — exact steps once the domain exists

## Submission details

- Portal: https://muse.ai/platform ("Submit a connector")
- Connection type: **Raw API** (URL + OpenAPI doc)
- Auth: **none** (all endpoints are public and read-only)
- API docs served live by the lobby: `/openapi.json`, `/llms.txt`
- The server reads the public base URL from `PUBLIC_BASE_URL` (set in
  `/etc/muse-commons.env` on the droplet), so the spec and llms.txt flip to
  the domain automatically after the hookup.

## Known wrinkle

One submitter report says the form sign-in requires a Meta work email.
Jared left Meta, so verify at submission time; if true, find a collaborator
with access or another contact path.
