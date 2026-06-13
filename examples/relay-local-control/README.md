# Relay Local Control Example

This example proves the V0.2 Bridge boundary:

- Product code encrypts `pwd` / `ls` requests into relay envelopes.
- Bridge Cloud and Desktop Bridge core only see ciphertext and routing metadata.
- A local Product Adapter decrypts the envelope, runs a tiny read-only allowlist, and returns an encrypted response envelope.
- The Adapter caches each response by inbound envelope id/request key so retries reuse the same encrypted response and do not re-run local commands.

Run:

```bash
npm run verify:relay-local-control
npm run verify:relay-local-control:blackbox
```

The example intentionally supports only:

- `pwd`
- `ls .`

It is not a general shell runner and must not be moved into Bridge core.
