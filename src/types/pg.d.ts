declare module 'pg' {
  export interface QueryResultRow { [column: string]: any }
  export interface QueryResult { rows: QueryResultRow[] }

  export class Pool {
    constructor(config?: any);
    query(text: string, params?: any[]): Promise<QueryResult>;
    end(): Promise<void>;
  }

  export { Pool };
}
