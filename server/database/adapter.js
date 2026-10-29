import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
// Only PostgreSQL's bounded integer/count parsers are changed; bigint values must stay safe.
pg.types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new Error("Database integer exceeds safe JSON range");
  return n;
});
const wrappers = new WeakMap();
export function sqliteAdapter(raw) {
  if (raw.dialect) return raw;
  if (wrappers.has(raw)) return wrappers.get(raw);
  const scope = new AsyncLocalStorage();
  let tail = Promise.resolve();
  const exclusive = (fn) => {
    if (scope.getStore()) return Promise.resolve().then(fn);
    const work = tail.then(() => scope.run(true, fn));
    tail = work.catch(() => {});
    return work;
  };
  const db = {
    dialect: "sqlite",
    raw,
    now: "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    date: "date(created_at)",
    eventOrder: "e.rowid",
    prepare: (sql) =>
      Object.fromEntries(
        ["get", "all", "run"].map((method) => [
          method,
          (...args) => exclusive(() => raw.prepare(sql)[method](...args)),
        ]),
      ),
    transaction: (fn) =>
      scope.getStore()
        ? fn()
        : exclusive(async () => {
            raw.exec("BEGIN IMMEDIATE");
            try {
              const result = await fn();
              raw.exec("COMMIT");
              return result;
            } catch (error) {
              raw.exec("ROLLBACK");
              throw error;
            }
          }),
    close: () => raw.close(),
  };
  wrappers.set(raw, db);
  return db;
}
// Bind placeholders in application-owned SQL only. Values always travel separately.
export function bindSql(sql, args) {
  const named =
    args.length === 1 &&
    args[0] &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0]);
  const values = [];
  const text = sql.replace(
    /'(?:''|[^'])*'|@[a-zA-Z_][a-zA-Z_0-9]*|\?/g,
    (token) => {
      if (token.startsWith("'")) return token;
      values.push(named ? args[0][token.slice(1)] : args[values.length]);
      return `$${values.length}`;
    },
  );
  return { text, values };
}
function normalize(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}
export function postgresAdapter(
  connectionString,
  { max = 5, ssl, schema } = {},
) {
  if (schema && !/^[a-z][a-z0-9_]+$/.test(schema))
    throw Error("Invalid schema");
  const pool = new pg.Pool({
    connectionString,
    max,
    ssl,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    options: `-c timezone=UTC -c statement_timeout=15000 -c lock_timeout=5000${schema ? ` -c search_path=${schema},public` : ""}`,
  });
  pool.on("error", (error) =>
    console.error("PostgreSQL idle client error:", error.code),
  );
  const scope = new AsyncLocalStorage();
  const db = {
    dialect: "postgres",
    pool,
    now: "CURRENT_TIMESTAMP",
    date: "to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD')",
    eventOrder: "e.event_order",
    prepare: (sql) => {
      const execute = async (args) => {
        const query = bindSql(sql, args);
        return (scope.getStore() || pool).query(query);
      };
      return {
        get: async (...args) => (await execute(args)).rows.map(normalize)[0],
        all: async (...args) => (await execute(args)).rows.map(normalize),
        run: async (...args) => ({ changes: (await execute(args)).rowCount }),
      };
    },
    transaction: async (fn) => {
      if (scope.getStore()) return fn();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await scope.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    // All progress transitions for one owner/chapter share a transaction lock.
    lockProgress: (user, chapter) =>
      db
        .prepare("SELECT pg_advisory_xact_lock(hashtextextended(?,0))")
        .get(`${user}:${chapter}`),
    close: () => pool.end(),
  };
  return db;
}
