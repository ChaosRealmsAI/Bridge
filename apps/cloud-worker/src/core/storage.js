import { clean, object } from "./utils.js";

const memory = makeMemoryStore();

export function bridgeTestMemorySnapshot() {
  return typeof memory.snapshot === "function" ? memory.snapshot() : {};
}

export class BridgeTestStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    const input = await request.json();
    const result = await this.applyOperation(input);
    return new Response(JSON.stringify(result, null, 2), {
      status: result?.error ? result.status || 400 : 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  async applyOperation(input) {
    const tableName = String(input.table || "");
    if (!tableName) return { error: "missing_table", status: 400 };
    const tableKey = bridgeTestStoreTableKey(tableName);
    const storedRows = await this.state.storage.get(tableKey);
    const rows = Array.isArray(storedRows) ? storedRows : [];
    const saveRows = async (nextRows) => {
      await this.state.storage.put(tableKey, nextRows);
    };

    if (input.op === "select") {
      return { rows: selectRows(rows, object(input.filters), object(input.options)) };
    }
    if (input.op === "insert") {
      const row = object(input.row);
      const duplicate = uniqueConflict(tableName, rows, row);
      if (duplicate) return { error: duplicate, status: 409 };
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      rows.push(next);
      await saveRows(rows);
      return { row: next };
    }
    if (input.op === "upsert") {
      const row = object(input.row);
      const conflictKey = String(input.conflictKey || "id");
      const index = rows.findIndex((item) => item[conflictKey] === row[conflictKey]);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...structuredClone(row) };
        await saveRows(rows);
        return { row: rows[index] };
      }
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      rows.push(next);
      await saveRows(rows);
      return { row: next };
    }
    if (input.op === "update") {
      const id = String(input.id || "");
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return { row: null };
      rows[index] = { ...rows[index], ...structuredClone(object(input.patch)) };
      await saveRows(rows);
      return { row: rows[index] };
    }
    if (input.op === "deleteExpired") {
      const column = String(input.column || "expires_at");
      const before = rows.length;
      const keep = rows.filter((row) => {
        const expiresAt = Date.parse(row[column] || "");
        return !Number.isFinite(expiresAt) || expiresAt > Date.now();
      });
      await saveRows(keep);
      return { count: before - keep.length };
    }
    if (input.op === "deleteWhere") {
      const filters = object(input.filters);
      const before = rows.length;
      const keep = rows.filter((row) => !Object.entries(filters).every(([key, value]) => row[key] === value));
      await saveRows(keep);
      return { count: before - keep.length };
    }
    return { error: "unknown_operation", status: 400 };
  }
}

function bridgeTestStoreTableKey(tableName) {
  return `table:${String(tableName).replace(/[^a-zA-Z0-9_:-]/g, "_")}`;
}

export function hasSupabase(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function storageKind(env) {
  const raw = storageKindRaw(env);
  return storageConfigurationError(env) ? "unconfigured" : raw;
}

export function storageKindRaw(env) {
  if (env.BRIDGE_STORAGE_BACKEND === "durable" && env.BRIDGE_TEST_STORE) return "durable";
  if (hasSupabase(env) && !env.BRIDGE_LOCAL_MEMORY) return "supabase";
  return "memory";
}

export function storage(env) {
  if (env.BRIDGE_STORAGE_BACKEND === "durable" && env.BRIDGE_TEST_STORE) return durableObjectStore(env);
  if (hasSupabase(env) && !env.BRIDGE_LOCAL_MEMORY) return supabaseStore(env);
  return memory;
}

export function storageConfigurationError(env) {
  if (!requiresPersistentStorage(env)) return null;
  if (storageKindRaw(env) !== "memory") return null;
  return {
    ok: false,
    error: "bridge_storage_unconfigured",
    message: "Bridge production/selfhost environments require persistent storage; configure Supabase service credentials or a persistent store.",
    env: env.BRIDGE_ENV || "production",
    storage: "unconfigured",
  };
}

export function requiresPersistentStorage(env) {
  const value = clean(env.BRIDGE_ENV, 64).toLowerCase();
  return ["production", "prod", "selfhost", "self-hosted", "self_hosted"].includes(value);
}

export function durableObjectStore(env) {
  return {
    async select(table, filters = {}, options = {}) {
      return (await durableStoreOperation(env, { op: "select", table, filters, options })).rows || [];
    },
    async insert(table, row) {
      return (await durableStoreOperation(env, { op: "insert", table, row })).row;
    },
    async upsert(table, row, conflictKey = "id") {
      return (await durableStoreOperation(env, { op: "upsert", table, row, conflictKey })).row;
    },
    async update(table, id, patch) {
      return (await durableStoreOperation(env, { op: "update", table, id, patch })).row;
    },
    async deleteExpired(table, column = "expires_at") {
      return (await durableStoreOperation(env, { op: "deleteExpired", table, column })).count || 0;
    },
    async deleteWhere(table, filters = {}) {
      return (await durableStoreOperation(env, { op: "deleteWhere", table, filters })).count || 0;
    },
  };
}

export async function durableStoreOperation(env, payload) {
  const id = env.BRIDGE_TEST_STORE.idFromName("bridge-test-store");
  const stub = env.BRIDGE_TEST_STORE.get(id);
  const response = await stub.fetch("https://bridge-test-store.local/storage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok || body.error) {
    const error = new Error(body.error || `durable_store_${response.status}`);
    error.code = body.error;
    throw error;
  }
  return body;
}

export function supabaseStore(env) {
  return {
    async select(table, filters = {}, options = {}) {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      url.searchParams.set("select", "*");
      for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, `eq.${value}`);
      if (options.order) url.searchParams.set("order", `${options.order}.${options.desc ? "desc" : "asc"}`);
      const response = await supabaseFetch(env, url, { method: "GET" });
      return response;
    },
    async insert(table, row) {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      const rows = await supabaseFetch(env, url, {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      return rows[0];
    },
    async upsert(table, row, conflictKey = "id") {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      url.searchParams.set("on_conflict", conflictKey);
      const rows = await supabaseFetch(env, url, {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      return rows[0];
    },
    async update(table, id, patch) {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      url.searchParams.set("id", `eq.${id}`);
      const rows = await supabaseFetch(env, url, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
      return rows[0];
    },
    async deleteExpired(table, column = "expires_at") {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      url.searchParams.set(column, `lt.${new Date().toISOString()}`);
      await supabaseFetch(env, url, { method: "DELETE" });
      return null;
    },
    async deleteWhere(table, filters = {}) {
      const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
      for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, `eq.${value}`);
      await supabaseFetch(env, url, { method: "DELETE" });
      return null;
    },
  };
}

export async function supabaseFetch(env, url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Supabase ${init.method} ${url.pathname} failed: ${response.status} [redacted]`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : [];
}

export function makeMemoryStore() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  return {
    async select(name, filters = {}, options = {}) {
      return selectRows(table(name), filters, options);
    },
    async insert(name, row) {
      const duplicate = uniqueConflict(name, table(name), row);
      if (duplicate) {
        const error = new Error(duplicate);
        error.code = duplicate;
        throw error;
      }
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      table(name).push(next);
      return structuredClone(next);
    },
    async upsert(name, row, conflictKey = "id") {
      const rows = table(name);
      const index = rows.findIndex((item) => item[conflictKey] === row[conflictKey]);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...structuredClone(row) };
        return structuredClone(rows[index]);
      }
      const next = { id: crypto.randomUUID(), ...structuredClone(row) };
      rows.push(next);
      return structuredClone(next);
    },
    async update(name, id, patch) {
      const rows = table(name);
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return null;
      rows[index] = { ...rows[index], ...structuredClone(patch) };
      return structuredClone(rows[index]);
    },
    async deleteExpired(name, column = "expires_at") {
      const rows = table(name);
      const keep = rows.filter((row) => {
        const expiresAt = Date.parse(row[column] || "");
        return !Number.isFinite(expiresAt) || expiresAt > Date.now();
      });
      const count = rows.length - keep.length;
      tables.set(name, keep);
      return count;
    },
    async deleteWhere(name, filters = {}) {
      const rows = table(name);
      const keep = rows.filter((row) => !Object.entries(filters).every(([key, value]) => row[key] === value));
      const count = rows.length - keep.length;
      tables.set(name, keep);
      return count;
    },
    snapshot() {
      return Object.fromEntries(
        [...tables.entries()].map(([name, rows]) => [
          name,
          rows.map((row) => structuredClone(row)),
        ]),
      );
    },
    reset() {
      tables.clear();
    },
  };
}

export function uniqueConflict(tableName, rows, row) {
  if (tableName === "bridge_relay_envelopes" && row.request_key) {
    const duplicate = rows.find((item) => (
      item.user_id === row.user_id
      && item.device_id === row.device_id
      && item.product_id === row.product_id
      && item.request_key === row.request_key
    ));
    if (duplicate) return "duplicate_request_key";
  }
  if (tableName === "bridge_product_delegation_nonces") {
    const duplicate = rows.find((item) => (
      item.product_id === row.product_id
      && item.nonce_hash === row.nonce_hash
    ));
    if (duplicate) return "product_delegation_replay";
  }
  return "";
}

export function selectRows(rows, filters = {}, options = {}) {
  let selected = rows.filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
  if (options.order) selected = selected.sort((a, b) => String(a[options.order] || "").localeCompare(String(b[options.order] || "")));
  if (options.desc) selected.reverse();
  return selected.map((row) => structuredClone(row));
}
