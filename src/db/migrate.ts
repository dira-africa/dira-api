import { Client } from "pg";
import fs from "fs";
import path from "path";
import { env } from "../config/env";

async function runMigrations() {
  const client = new Client({
    connectionString: env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log("Connected to database for running migrations.");

    // Check if PostGIS extension is available
    let postgisAvailable = true;
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "postgis";');
      console.log("PostGIS extension is active.");
    } catch (e) {
      console.warn("⚠️ PostGIS extension is not available. Setting up PostGIS mock types/functions for local environment...");
      postgisAvailable = false;
      
      // Create mock types & spatial functions
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geometry') THEN
            CREATE TYPE geometry AS (dummy text);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geography') THEN
            CREATE TYPE geography AS (dummy text);
          END IF;
        END
        $$;

        CREATE OR REPLACE FUNCTION PostGIS_version() RETURNS text AS $$
        BEGIN
          RETURN '3.4.2 MOCK';
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ST_Point(x double precision, y double precision) RETURNS geometry AS $$
        BEGIN
          RETURN ROW('POINT(' || x || ' ' || y || ')')::geometry;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ST_SetSRID(geom geometry, srid integer) RETURNS geometry AS $$
        BEGIN
          RETURN geom;
        END;
        $$ LANGUAGE plpgsql;
      `);
    }

    // Create migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        run_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Get list of already executed migrations
    const { rows } = await client.query("SELECT name FROM migrations ORDER BY id ASC");
    const executedMigrations = new Set(rows.map((r) => r.name));

    // Read and sort migration files
    const migrationsDir = path.join(__dirname, "migrations");
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const pendingMigrations = files.filter((f) => !executedMigrations.has(f));

    if (pendingMigrations.length === 0) {
      console.log("No new migrations to run.");
      return;
    }

    console.log(`Found ${pendingMigrations.length} new migrations to execute.`);

    // Run pending migrations in a single transaction
    await client.query("BEGIN");
    try {
      for (const file of pendingMigrations) {
        console.log(`  Executing ${file}...`);
        const filePath = path.join(migrationsDir, file);
        let sqlContent = fs.readFileSync(filePath, "utf8");

        if (!postgisAvailable) {
          // If PostGIS is mocked, remove the PostGIS extension load line
          if (file === "001_extensions.sql") {
            sqlContent = sqlContent.replace('CREATE EXTENSION IF NOT EXISTS "postgis";', '-- PostGIS mocked');
          }
          // Remove type modifiers from geometry column definitions: e.g. GEOMETRY(Point, 4326) -> geometry
          sqlContent = sqlContent.replace(/GEOMETRY\([^)]+\)/gi, "geometry");
          // Remove spatial index creation using GIST since custom types cannot be indexed via GIST natively
          sqlContent = sqlContent.replace(/CREATE INDEX .* ON .* USING GIST .*/gi, "-- GIST Index skipped in PostGIS mock mode");
        }

        // Execute the SQL content
        await client.query(sqlContent);

        // Record the migration
        await client.query("INSERT INTO migrations (name) VALUES ($1)", [file]);
      }
      await client.query("COMMIT");
      console.log("✅ All pending migrations ran and recorded successfully.");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    }

  } catch (err: any) {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();
