import type { IdentifierQuoteStyle } from '../types/dbType';

const SHARED_KEYWORDS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
  'FULL', 'CROSS', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS',
  'AS', 'DISTINCT', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX',
  'INTO', 'VALUES', 'SET', 'ASC', 'DESC', 'WITH', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'CONSTRAINT', 'UNIQUE', 'CHECK', 'DEFAULT',
];

const MYSQL_KEYWORDS = ['SHOW', 'REPLACE', 'DUPLICATE', 'IGNORE', 'USE', 'DATABASE', 'DATABASES', 'REGEXP'];

const DM_KEYWORDS = ['MERGE', 'TOP', 'ROWNUM', 'CONNECT', 'START', 'PRIOR', 'SYSDATE', 'LEVEL', 'MINUS'];

const SHARED_FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'CONCAT'];

const MYSQL_FUNCTIONS = ['IFNULL', 'NOW', 'GROUP_CONCAT', 'DATE_FORMAT', 'IF'];

const DM_FUNCTIONS = ['NVL', 'NVL2', 'DECODE', 'TO_CHAR', 'TO_DATE'];

const TABLE_INTRODUCERS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO']);

const CLAUSE_WORDS = new Set([
  ...SHARED_KEYWORDS,
  ...MYSQL_KEYWORDS,
  ...DM_KEYWORDS,
  'USING', 'QUALIFY', 'DECLARE', 'BEGIN', 'EXCEPTION', 'RETURN', 'INTERSECT',
]);

export type SqlCompletionDialect = 'mysql' | 'dm';

export type CompletionTarget =
  | { kind: 'word'; prefix: string }
  | { kind: 'object'; prefix: string }
  | { kind: 'column'; table: string; prefix: string };

export interface SqlCompletionItem {
  label: string;
  insertText: string;
  kind: 'keyword' | 'function' | 'table' | 'view' | 'column';
  sortText: string;
}

interface SqlToken {
  type: 'word' | 'dot';
  text: string;
  start: number;
  end: number;
}

export function completionDialect(dbType?: string | null): SqlCompletionDialect {
  const normalized = (dbType ?? '').trim().toLowerCase();
  if (normalized === 'dm' || normalized.includes('dameng')) return 'dm';
  return 'mysql';
}

export function completionWords(dbType?: string | null): { keywords: string[]; functions: string[] } {
  if (completionDialect(dbType) === 'dm') {
    return {
      keywords: unique([...SHARED_KEYWORDS, ...DM_KEYWORDS]),
      functions: unique([...SHARED_FUNCTIONS, ...DM_FUNCTIONS]),
    };
  }
  return {
    keywords: unique([...SHARED_KEYWORDS, ...MYSQL_KEYWORDS]),
    functions: unique([...SHARED_FUNCTIONS, ...MYSQL_FUNCTIONS]),
  };
}

export function completionQuoteStyle(
  dbType?: string | null,
  configured?: IdentifierQuoteStyle,
): IdentifierQuoteStyle {
  if (configured) return configured;
  return completionDialect(dbType) === 'dm' ? 'double_quote' : 'backtick';
}

export function quoteIdent(name: string, quoteStyle: IdentifierQuoteStyle = 'double_quote'): string {
  if (!name || quoteStyle === 'none') return name;
  if (quoteStyle === 'backtick') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Decide what the cursor is asking for. Alias lookup uses the whole current statement. */
export function completionTarget(textUntilCursor: string, followingText = ''): CompletionTarget | null {
  const cursor = textUntilCursor.length;
  const sql = textUntilCursor + followingText;
  const statement = statementAround(sql, cursor);
  const localCursor = cursor - statement.start;
  if (insideLiteral(statement.text, localCursor)) return null;

  const tokens = tokenize(statement.text);
  const typing = tokens.find((token) =>
    token.type === 'word' && token.start < localCursor && localCursor <= token.end
    && isIdentChar(statement.text[localCursor - 1] ?? ''));
  const prefix = typing ? typing.text.slice(0, localCursor - typing.start) : '';
  const boundary = typing ? typing.start : localCursor;
  const before = tokens.filter((token) => token.end <= boundary);
  const previous = before.at(-1);

  if (previous?.type === 'dot') {
    const qualifier = before.at(-2);
    if (!qualifier || qualifier.type !== 'word') return null;
    return {
      kind: 'column',
      table: resolveTable(tokens, unquote(qualifier.text)),
      prefix,
    };
  }

  const previousWord = [...before].reverse().find((token) => token.type === 'word');
  if (previousWord && TABLE_INTRODUCERS.has(previousWord.text.toUpperCase())) {
    return { kind: 'object', prefix };
  }
  return { kind: 'word', prefix };
}

export function buildSuggestions(args: {
  dbType?: string | null;
  quoteStyle?: IdentifierQuoteStyle;
  target: CompletionTarget;
  tables?: string[];
  views?: string[];
  functions?: string[];
  columns?: string[];
}): SqlCompletionItem[] {
  const quoteStyle = args.quoteStyle ?? completionQuoteStyle(args.dbType);
  const words = completionWords(args.dbType);
  const prefix = args.target.prefix;
  const items: SqlCompletionItem[] = [];

  if (args.target.kind === 'column') {
    pushNames(items, args.columns ?? [], prefix, 'column', quoteStyle, '4');
    return items;
  }

  if (args.target.kind === 'object') {
    pushNames(items, args.tables ?? [], prefix, 'table', quoteStyle, '2');
    pushNames(items, args.views ?? [], prefix, 'view', quoteStyle, '3');
    return items;
  }

  pushLabels(items, words.keywords, prefix, 'keyword', '0');
  pushLabels(items, words.functions, prefix, 'function', '1');
  pushLabels(items, args.functions ?? [], prefix, 'function', '1');
  if (prefix) {
    pushNames(items, args.tables ?? [], prefix, 'table', quoteStyle, '2');
    pushNames(items, args.views ?? [], prefix, 'view', quoteStyle, '3');
  }
  return items;
}

function pushLabels(
  items: SqlCompletionItem[],
  labels: string[],
  prefix: string,
  kind: SqlCompletionItem['kind'],
  sortGroup: string,
) {
  const seen = new Set(items.filter((item) => item.kind === kind).map((item) => item.label.toUpperCase()));
  for (const label of labels) {
    if (!label || seen.has(label.toUpperCase()) || !startsWithIgnoreCase(label, prefix)) continue;
    seen.add(label.toUpperCase());
    items.push({ label, insertText: label, kind, sortText: `${sortGroup}-${label.toUpperCase()}` });
  }
}

function pushNames(
  items: SqlCompletionItem[],
  names: string[],
  prefix: string,
  kind: SqlCompletionItem['kind'],
  quoteStyle: IdentifierQuoteStyle,
  sortGroup: string,
) {
  const seen = new Set(items.filter((item) => item.kind === kind).map((item) => item.label.toUpperCase()));
  for (const name of names) {
    const label = unquote(name);
    if (!label || seen.has(label.toUpperCase()) || !startsWithIgnoreCase(label, prefix)) continue;
    seen.add(label.toUpperCase());
    items.push({
      label,
      insertText: quoteIdent(label, quoteStyle),
      kind,
      sortText: `${sortGroup}-${label.toUpperCase()}`,
    });
  }
}

function resolveTable(tokens: SqlToken[], qualifier: string): string {
  const aliases = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'word' || !TABLE_INTRODUCERS.has(token.text.toUpperCase())) continue;
    const table = tokens[index + 1];
    if (!table || table.type !== 'word') continue;
    let aliasIndex = index + 2;
    if (tokens[aliasIndex]?.type === 'word' && tokens[aliasIndex].text.toUpperCase() === 'AS') {
      aliasIndex += 1;
    }
    const alias = tokens[aliasIndex];
    if (!alias || alias.type !== 'word' || CLAUSE_WORDS.has(alias.text.toUpperCase())) continue;
    aliases.set(alias.text.toUpperCase(), unquote(table.text));
  }
  return aliases.get(qualifier.toUpperCase()) ?? qualifier;
}

function statementAround(sql: string, cursor: number): { text: string; start: number } {
  let start = 0;
  let state: ScanState = 'code';
  let index = 0;
  while (index < cursor && index < sql.length) {
    if (state === 'code' && sql[index] === ';') start = index + 1;
    const step = stepScan(sql, index, state);
    state = step.state;
    index += step.consume;
  }
  let end = sql.length;
  state = 'code';
  index = start;
  while (index < sql.length) {
    if (state === 'code' && sql[index] === ';' && index >= cursor) {
      end = index;
      break;
    }
    const step = stepScan(sql, index, state);
    state = step.state;
    index += step.consume;
  }
  return { text: sql.slice(start, end), start };
}

function insideLiteral(sql: string, cursor: number): boolean {
  let state: ScanState = 'code';
  let index = 0;
  while (index < cursor && index < sql.length) {
    const step = stepScan(sql, index, state);
    state = step.state;
    index += step.consume;
  }
  return state !== 'code';
}

function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let state: ScanState = 'code';
  let index = 0;
  while (index < sql.length) {
    if (state === 'code') {
      const quoted = readQuoted(sql, index);
      if (quoted) {
        tokens.push({ type: 'word', text: quoted.text, start: index, end: index + quoted.length });
        index += quoted.length;
        continue;
      }
      if (isIdentStart(sql[index])) {
        const start = index;
        index += 1;
        while (index < sql.length && isIdentChar(sql[index])) index += 1;
        tokens.push({ type: 'word', text: sql.slice(start, index), start, end: index });
        continue;
      }
      if (sql[index] === '.') {
        tokens.push({ type: 'dot', text: '.', start: index, end: index + 1 });
      }
    }
    const step = stepScan(sql, index, state);
    state = step.state;
    index += step.consume;
  }
  return tokens;
}

type ScanState = 'code' | 'line' | 'block' | 'single' | 'double' | 'backtick';

function stepScan(sql: string, index: number, state: ScanState): { state: ScanState; consume: number } {
  const char = sql[index];
  const next = sql[index + 1];
  if (state === 'line') return { state: char === '\n' ? 'code' : 'line', consume: 1 };
  if (state === 'block') {
    return next === '/' && char === '*'
      ? { state: 'code', consume: 2 }
      : { state: 'block', consume: 1 };
  }
  if (state === 'single') {
    if (char === "'" && next === "'") return { state, consume: 2 };
    return { state: char === "'" ? 'code' : state, consume: 1 };
  }
  if (state === 'double') {
    if (char === '"' && next === '"') return { state, consume: 2 };
    return { state: char === '"' ? 'code' : state, consume: 1 };
  }
  if (state === 'backtick') {
    if (char === '`' && next === '`') return { state, consume: 2 };
    return { state: char === '`' ? 'code' : state, consume: 1 };
  }
  if (char === '-' && next === '-') return { state: 'line', consume: 2 };
  if (char === '/' && next === '*') return { state: 'block', consume: 2 };
  if (char === "'") return { state: 'single', consume: 1 };
  if (char === '"') return { state: 'double', consume: 1 };
  if (char === '`') return { state: 'backtick', consume: 1 };
  return { state: 'code', consume: 1 };
}

function readQuoted(sql: string, index: number): { text: string; length: number } | null {
  const quote = sql[index];
  if (quote !== '"' && quote !== '`') return null;
  let end = index + 1;
  let text = '';
  while (end < sql.length) {
    if (sql[end] === quote && sql[end + 1] === quote) {
      text += quote;
      end += 2;
      continue;
    }
    if (sql[end] === quote) {
      return { text, length: end + 1 - index };
    }
    text += sql[end];
    end += 1;
  }
  return null;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === '`') && value[value.length - 1] === quote) {
      return value.slice(1, -1).replaceAll(quote + quote, quote);
    }
  }
  return value;
}

function startsWithIgnoreCase(label: string, prefix: string): boolean {
  return label.toLowerCase().startsWith(prefix.toLowerCase());
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_\u0080-\uFFFF]/.test(char);
}

function isIdentChar(char: string): boolean {
  return /[A-Za-z0-9_$#\u0080-\uFFFF]/.test(char);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
