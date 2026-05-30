import { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { pool } from "../db/pool";

declare module "fastify" {
  interface FastifyInstance {
    db: typeof pool;
  }
}

const databasePlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Verify connection on startup
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    fastify.log.info("Database connection handshake successful.");
  } catch (err: any) {
    fastify.log.error(`Database connection error: ${err.message}`);
    throw new Error(`Failed to connect to the database at startup: ${err.message}`);
  }

  // Decorate Fastify instance with 'db'
  fastify.decorate("db", pool);

  // Graceful shutdown
  fastify.addHook("onClose", async (instance) => {
    instance.log.info("Closing database connection pool...");
    await pool.end();
    instance.log.info("Database connection pool closed successfully.");
  });
};

export default fp(databasePlugin);
