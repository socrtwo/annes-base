import type { Database } from 'sql.js';
import type { Cell } from './database';
import { quoteName, rows } from './journal';
import { compileView, type TableColumn, type TableView } from './tableView';

export type TotalOperation = 'count' | 'sum' | 'average' | 'min' | 'max' | 'stdev' | 'variance';
export interface TotalChoice { column: string; operation: TotalOperation }
export interface TotalValue extends TotalChoice { value: Cell; error?: string }
export interface TableTotals { records: bigint; values: TotalValue[] }
export const TOTAL_OPERATIONS: { value: TotalOperation; label: string }[] = [
  { value: 'count', label: 'Count values' }, { value: 'sum', label: 'Sum' }, { value: 'average', label: 'Average' },
  { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' },
  { value: 'stdev', label: 'Standard deviation' }, { value: 'variance', label: 'Variance' },
];
const NUMERIC_ONLY: TotalOperation[] = ['sum', 'average', 'stdev', 'variance'];
export function totalsFor(column: TableColumn) {
  return TOTAL_OPERATIONS.filter(operation => column.kind === 'blob' ? operation.value === 'count'
    : column.kind === 'text' || column.kind === 'date' ? !NUMERIC_ONLY.includes(operation.value) : true);
}

/** Read-only aggregates over the complete WHERE result, independent of page and sort order. */
export function tableTotals(db: Database, table: string, columns: TableColumn[], choices: TotalChoice[], view: TableView): TableTotals {
  if (!Array.isArray(choices) || choices.length > columns.length) throw new Error('Choose at most one total per column.');
  const seen = new Set<string>();
  for (const choice of choices) {
    const column = columns.find(column => column.name === choice?.column);
    if (!column || seen.has(column.name) || !totalsFor(column).some(operation => operation.value === choice.operation)) throw new Error('Choose a supported total once per column.');
    seen.add(column.name);
  }
  const query = compileView(columns, view);
  const from = ` FROM ${quoteName(table)}${query.where}`;
  const records = rows(db, 'SELECT COUNT(*)' + from, query.params)[0][0] as bigint;
  const functions = { count: 'COUNT', sum: 'SUM', average: 'AVG', min: 'MIN', max: 'MAX' };
  const values = choices.map(choice => {
    const column = quoteName(choice.column);
    try {
      if (NUMERIC_ONLY.includes(choice.operation)) {
        // SQLite otherwise silently treats nonnumeric text as zero in numeric totals.
        const invalid = rows(db, `SELECT COUNT(CASE WHEN ${column} IS NOT NULL AND typeof(${column}) NOT IN ('integer','real') THEN 1 END)` + from, query.params)[0][0];
        if (invalid !== 0n) throw new Error('This result contains nonnumeric values. Narrow the filter or choose Count, Minimum or Maximum.');
      }
      let value: Cell;
      if (choice.operation === 'stdev' || choice.operation === 'variance') {
        // Two-pass sample variance avoids the cancellation error of AVG(x*x) - AVG(x)^2.
        const [count, mean] = rows(db, `SELECT COUNT(${column}), AVG(${column})` + from, query.params)[0];
        if (Number(count) < 2) value = null;
        else {
          const squares = Number(rows(db, `SELECT SUM((${column} - ?) * (${column} - ?))` + from, [mean as number, mean as number, ...query.params])[0][0]);
          const variance = squares / (Number(count) - 1);
          value = choice.operation === 'variance' ? variance : Math.sqrt(variance);
        }
      } else value = rows(db, `SELECT ${functions[choice.operation as keyof typeof functions]}(${column})` + from, query.params)[0][0];
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('This numeric result is not finite. Narrow the filter or choose another total.');
      return { ...choice, value };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      return { ...choice, value: null, error: /integer overflow/i.test(message) ? 'The integer sum is outside the signed 64-bit range. Narrow the filter or choose another total.' : message };
    }
  });
  return { records, values };
}
