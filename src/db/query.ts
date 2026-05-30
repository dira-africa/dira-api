import { QueryResult, QueryResultRow } from "pg";
import { pool } from "./pool";

export class DatabaseError extends Error {
  constructor(message: string, public readonly originalError: any) {
    super(message);
    this.name = "DatabaseError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DatabaseError);
    }
  }
}

/**
 * Executes a PostgreSQL query using the shared connection pool.
 * Slow queries (>500ms) trigger warning logs.
 * Database errors are caught and wrapped in a DatabaseError to prevent leaking internal schemas.
 *
 * @template T The expected row structure.
 * @param text The SQL query string.
 * @param params The query parameters array.
 * @returns A promise resolving to the QueryResult.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      console.warn(`[WARNING] Slow query detected (${duration}ms): ${text}`);
    }
    
    return result;
  } catch (err: any) {
    console.error(`Database error executing query: ${text}`, err);
    throw new DatabaseError("A database query error occurred.", err);
  }
}
