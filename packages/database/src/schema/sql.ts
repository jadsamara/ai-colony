import { sql, type SQL } from "drizzle-orm";

export function textIn(columnName: string, values: readonly string[]): SQL {
  const list = values
    .map((value) => {
      if (!/^[A-Za-z0-9_:-]+$/.test(value)) {
        throw new Error(`Refusing to embed SQL check value "${value}"`);
      }
      return `'${value}'`;
    })
    .join(", ");
  return sql.raw(`${columnName} in (${list})`);
}
