# Bridge Notes

Bridge Notes is a real Panda Bridge example product for local notes.

It uses the SDK as the product integration boundary:

- `createBridgeClient({ productId: "panda-notes" })`
- `connect.createIntent()` with caller-declared permissions
- `ensureReady()` for active authorization + online desktop
- `codex.chat`, `data.put/get/query/delete`, and `jobs.create({ kind: "fs.read" })`

The note body is written as `data.put` job `input.value.body`. The desktop data connector stores it in the product-scoped local SQLite file under `~/.panda-bridge/data/products/panda-notes-*.sqlite3`. The `data.put` result does not include the note body.

## Install

```bash
cd examples/bridge-notes
npm install
```

For a local Bridge API:

```bash
export PANDA_BRIDGE_API_BASE=http://127.0.0.1:8787
```

## CLI

```bash
node src/cli.mjs login --guest "Bridge Notes User"
node src/cli.mjs authorize
node src/cli.mjs status
node src/cli.mjs note add "First note" "hello from local sqlite"
node src/cli.mjs note ls
node src/cli.mjs note get <note-id>
node src/cli.mjs chat "Reply exactly: notes-codex-ok"
node src/cli.mjs fs pull /absolute/path/inside/bound/root.txt
```

After `authorize`, open the printed `deep_link` in Panda Bridge Desktop. For headless dogfood, bind the declared fs root with:

```bash
cargo run --quiet --manifest-path apps/desktop/Cargo.toml -- \
  headless-bind-local-root \
  --product-id panda-notes \
  --root-id notes-import \
  --domain fs_read \
  --path /absolute/import/root
```

## Dogfood

From the repo root:

```bash
node scripts/verify/bridge-notes-dogfood.mjs
npm run check
cargo test --manifest-path apps/desktop/Cargo.toml headless_bind_local_root_infers_account_and_path_display
```

The dogfood harness starts a real in-memory cloud worker, a real desktop headless connector process, and runs three legs:

- Codex chat round trip
- `data.put` to local SQLite, worker/result body scrub proof, `data.query`, and true delete
- caller-declared fs root binding, authorized read, and out-of-root denial
