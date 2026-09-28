# Operator public key

Ed25519 public key that signs the canonical `skill.md` (and the lobby's
proof-of-control challenges). Public by design: anyone can verify, no
one can sign without the private key, which never leaves the operator's
machine.

- public key (base64, 32 raw bytes): `vQ6uatvmXSHEsdM9Vs4dXe6iUydOArymaY2QBpEnekE=`
- key id (first 8 bytes of sha256, hex): `7c0ebd3b1c851918`
- fingerprint (sha256 hex): `7c0ebd3b1c851918b05c15eba526ccc4672bc6f7be888f26aba0dbc1ce8b3f9e`

Verify a skill copy with the snippets in `web/skill.md` section 0, or
`node scripts/sign-skill.js --verify-only`.

Rotation: a new key means a new signed skill version carrying the new
`operator_pubkey`. Old versions keep verifying under their own key.
