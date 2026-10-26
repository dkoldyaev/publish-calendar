import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { ApiConfig } from '../config/env.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
}

export interface DatabasePool extends DatabaseClient {
  withTransaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T>;
  execSqlScript(sql: string): Promise<void>;
  close(): Promise<void>;
}

class PgPoolAdapter implements DatabasePool {
  private readonly pool: pg.Pool;

  constructor(config: ApiConfig) {
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      connectionTimeoutMillis: config.databaseConnectTimeoutMs,
    });
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length,
    };
  }

  async execSqlScript(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async withTransaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const txClient: DatabaseClient = {
      async query<R = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ): Promise<QueryResult<R>> {
        const res = await client.query(sql, params);
        return {
          rows: res.rows as R[],
          rowCount: res.rowCount ?? res.rows.length,
        };
      },
    };
    try {
      await client.query('BEGIN');
      const result = await fn(txClient);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PGliteAdapter implements DatabasePool {
  private readonly db: PGlite;
  private txMutex: Promise<void> = Promise.resolve();

  constructor(databaseUrl: string) {
    const parsed = new URL(databaseUrl);
    const hostOrPath = parsed.hostname
      ? `${parsed.hostname}${parsed.pathname}`
      : parsed.pathname;
    if (
      hostOrPath === 'memory' ||
      hostOrPath === 'memory/' ||
      hostOrPath === '/memory' ||
      hostOrPath === ''
    ) {
      this.db = new PGlite();
    } else {
      this.db = new PGlite(hostOrPath);
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const res = await this.db.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async execSqlScript(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async withTransaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    let releaseMutex: () => void = () => undefined;
    const prevMutex = this.txMutex;
    this.txMutex = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    await prevMutex;

    try {
      return await this.db.transaction(async (tx) => {
        const txClient: DatabaseClient = {
          async query<R = Record<string, unknown>>(
            sql: string,
            params?: unknown[]
          ): Promise<QueryResult<R>> {
            const res = await tx.query<R>(sql, params);
            return {
              rows: res.rows,
              rowCount: res.affectedRows ?? res.rows.length,
            };
          },
        };
        return await fn(txClient);
      });
    } finally {
      releaseMutex();
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export function createDatabasePool(config: ApiConfig): DatabasePool {
  if (config.databaseUrl.startsWith('pglite:')) {
    return new PGliteAdapter(config.databaseUrl);
  }
  return new PgPoolAdapter(config);
}
