// Explicit operator-only bootstrap, never imported by HTTP routes. No existing roles altered.
export async function createReleaseRoles(
  admin,
  { prefix = "soundwave", migratorPassword, runtimePassword } = {},
) {
  if (
    !/^[a-z][a-z0-9_]{0,32}$/.test(prefix) ||
    [migratorPassword, runtimePassword].some(
      (p) =>
        typeof p !== "string" ||
        p.length < 24 ||
        p.length > 256 ||
        /[\u0000-\u001f]/.test(p),
    ) ||
    migratorPassword === runtimePassword
  )
    throw Error(
      "Provide a safe role prefix and distinct 24–256 character credentials.",
    );
  const migrator = prefix + "_migrator",
    runtime = prefix + "_runtime";
  const sql = async (format, ...args) => {
    const { rows } = await admin.query(
      "SELECT format($1::text,VARIADIC $2::text[]) AS statement",
      [format, args],
    );
    return admin.query(rows[0].statement);
  };
  await admin.query("BEGIN");
  try {
    await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "release-roles:" + prefix,
    ]);
    if (
      (
        await admin.query(
          "SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])",
          [[migrator, runtime]],
        )
      ).rowCount
    )
      throw Error(
        "Release roles already exist; drain writers and rotate credentials explicitly.",
      );
    await sql(
      "CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L",
      migrator,
      migratorPassword,
    );
    await sql(
      "CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L",
      runtime,
      runtimePassword,
    );
    if (
      (
        await admin.query(
          "SELECT 1 FROM pg_tables WHERE schemaname='public' LIMIT 1",
        )
      ).rowCount
    )
      throw Error(
        "Bootstrap requires an empty database; use a reviewed restore/ownership procedure for existing data.",
      );
    await admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const name = (await admin.query("SELECT current_database() AS name"))
      .rows[0].name;
    await sql("REVOKE CONNECT,TEMPORARY ON DATABASE %I FROM PUBLIC", name);
    await sql(
      "GRANT CONNECT ON DATABASE %I TO %I, %I",
      name,
      migrator,
      runtime,
    );
    await sql("GRANT USAGE,CREATE ON SCHEMA public TO %I", migrator);
    await sql("GRANT USAGE ON SCHEMA public TO %I", runtime);
    await sql(
      "ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO %I",
      migrator,
      runtime,
    );
    await sql(
      "ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO %I",
      migrator,
      runtime,
    );
    await sql("SET LOCAL ROLE %I", migrator);
    await admin.query(
      "CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
    );
    await admin.query("RESET ROLE");
    await sql(
      "REVOKE INSERT,UPDATE,DELETE ON TABLE schema_migrations FROM %I",
      runtime,
    );
    await admin.query("COMMIT");
    return { migrator, runtime };
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }
}
