# Panda Bridge Desktop User Guide

Panda Bridge Desktop lets an approved product exchange encrypted relay
envelopes with a local Product Adapter on this computer.

## First Authorization

1. Install and open Panda Bridge Desktop.
2. Sign in to the product that wants to connect this computer.
3. Click the product's local Bridge connect action.
4. The Desktop app opens an authorization view.
5. Check the product name, account, source origin, relay capabilities, requested
   Adapter boundary, and risk summary.
6. Click Allow.

After approval, the product appears in Desktop with a local authorization
record. Bridge Desktop uses that record to decide whether encrypted relay
envelopes may be delivered to the product's local Adapter. Product command
schemas, plaintext, and local execution stay inside the product app and Product
Adapter.

## Local Authorization Record

Desktop shows:

- Product name and source origin.
- Authorized account and device id.
- Relay capabilities such as `relay.envelope` and `relay.ack`.
- Product Adapter boundary summary.
- Authorization time and current connection state.

Desktop does not show device tokens, session cookies, product secrets, relay
plaintext, or private credential storage paths.

## Multiple Products

Every product gets its own record. Authorizing one product does not authorize
another product. Revoking one product only removes that product's access.

## Revocation

Open the product detail in Desktop and remove the authorized account. Bridge
Cloud will stop treating that product/device authorization as ready. Later relay
envelopes for that product are rejected instead of continuing silently.

## Troubleshooting

- If the product says Bridge is not ready, open Desktop and check that the
  product record exists and is active.
- If Desktop is offline, reopen Panda Bridge Desktop and wait for heartbeat to
  restore the connection.
- If one product works and another does not, authorize the second product
  separately.
- If a product needs a different Adapter boundary, re-authorize the product so
  the Desktop record captures the new requested policy.
