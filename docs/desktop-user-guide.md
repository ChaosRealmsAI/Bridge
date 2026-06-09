# Panda Bridge Desktop User Guide

Panda Bridge Desktop lets a product use the AI runtime on your computer after
you approve that product.

## First Authorization

1. Install and open Panda Bridge Desktop.
2. Sign in to the product that wants to use this computer.
3. Click the product's `Connect local Agent` action.
4. The Desktop app opens an authorization view.
5. Check the product name, account, source origin, capabilities, workspace,
   sandbox, and approval policy.
6. Click Allow.

After approval, the product appears in Desktop with a local authorization
record. That record is kept on this computer and is used by the local runtime
before executing jobs.

## Local Authorization Record

Desktop shows:

- Product name and source origin.
- Authorized account and device id.
- Capability list such as `codex.chat` or `codex.run`.
- Local policy summary, including workspace, sandbox, and approval policy.
- Authorization time.

Desktop does not show device tokens, session cookies, product secrets, or
private credential storage paths.

## Multiple Products

Every product gets its own record. Authorizing Panda Chat does not automatically
authorize Panda Dev. Revoking one product only removes that product's access.

## Revocation

Open the product detail in Desktop and sign out the authorized account. Bridge
Cloud will stop treating that product/device authorization as ready, and queued
or later jobs for that product will fail instead of continuing silently.

## Troubleshooting

- If the product says Bridge is not ready, open Desktop and check that the
  product record exists.
- If Desktop says Codex is missing, run `codex login` on this computer.
- If one product works and another does not, authorize the second product
  separately.
- If you changed local permission settings, re-authorize the product so the
  Desktop record captures the current policy.
