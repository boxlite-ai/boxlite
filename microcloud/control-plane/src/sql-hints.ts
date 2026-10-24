/**
 * The next step for a Postgres error an agent's SQL ran into, by SQLSTATE, naming the table,
 * column or constraint Postgres reported. Undefined when there is nothing better than the generic
 * hint (errors.ts sql_error).
 */
export interface PgErrorFields {
  code?: string;
  message?: string;
  table?: string;
  column?: string;
  constraint?: string;
  detail?: string;
}

const quoted = (message: string | undefined) => message?.match(/"([^"]+)"/)?.[1];

export function sqlErrorNext(e: PgErrorFields): string | undefined {
  const schema = '`boxlite-app app db schema`';
  switch (e.code) {
    case '25006': // read_only_sql_transaction: the guard misses functions that write and writable CTEs
      return 'this statement writes; rerun it with --write';
    case '42P01': {
      const table = quoted(e.message);
      return `${table ? `there is no table ${table}` : 'that table does not exist'}: ${schema} lists the tables; a new table comes from a migration (\`boxlite-app app db migration new <name>\`, then \`boxlite-app deploy\`)`;
    }
    case '42703': {
      const column = quoted(e.message);
      return `${column ? `there is no column ${column}` : 'that column does not exist'}: ${schema} lists each table's columns; add one with a migration`;
    }
    case '23505':
      return `a row with that value already exists${e.constraint ? ` (unique constraint ${e.constraint}${e.detail ? `: ${e.detail}` : ''})` : ''}; update it instead, or use INSERT … ON CONFLICT … DO UPDATE / DO NOTHING`;
    case '23503':
      return `${e.detail ?? 'the row it points to does not exist, or other rows still point to it'}${e.constraint ? ` (foreign key ${e.constraint})` : ''}; insert the referenced row first, or delete the referencing rows first`;
    case '23502':
      return `${e.column ? `column ${e.column}` : 'a NOT NULL column'}${e.table ? ` of ${e.table}` : ''} needs a value; set it in the statement, or give it a DEFAULT in a migration`;
    case '23514':
      return `the row breaks check constraint ${e.constraint ?? '(see the message)'}${e.table ? ` on ${e.table}` : ''}; ${schema} shows the table`;
    case '22P02':
    case '22007':
    case '22008':
      return "a value has the wrong type for its column (a number, uuid, boolean or date written as text that does not parse); cast it or quote it correctly, e.g. '2026-10-23'::date";
    case '42601':
      return 'a syntax error: the error position points at where the parser stopped; check commas, quotes and keywords just before it';
    case '42883':
      return 'no function or operator matches those argument types; cast the arguments (e.g. id::text) or check the function name';
    case '42501':
      return 'the database login cannot do that: reads run as a read-only role, writes need --write, and on main DDL belongs in a migration';
    case '57014':
      return 'the statement ran past its time limit; add a WHERE or LIMIT, or an index (in a migration) for what it filters on';
    case '40P01':
      return 'two transactions deadlocked; rerun it, and keep transactions short and in a consistent table order';
    default:
      return undefined;
  }
}
