import { describe, expect, it } from 'vitest';
import { buildSuggestions, completionTarget, completionWords } from './sqlCompletion';

function labels(dbType: string, textUntilCursor: string, followingText = '', tables: string[] = [], columns: string[] = []) {
  const target = completionTarget(textUntilCursor, followingText);
  expect(target).not.toBeNull();
  return buildSuggestions({
    dbType,
    target: target!,
    tables,
    columns,
  }).map((item) => item.insertText);
}

describe('SQL completion', () => {
  it('offers SELECT while typing the keyword in both dialects', () => {
    expect(labels('mysql', 'SEL')).toContain('SELECT');
    expect(labels('dm', 'sel')).toContain('SELECT');
  });

  it('keeps MySQL and DM keywords and functions apart', () => {
    expect(completionWords('mysql').keywords).toContain('SHOW');
    expect(completionWords('mysql').functions).toContain('IFNULL');
    expect(completionWords('dm').keywords).not.toContain('SHOW');
    expect(completionWords('dm').functions).not.toContain('IFNULL');

    expect(completionWords('dm').keywords).toContain('ROWNUM');
    expect(completionWords('dm').functions).toContain('NVL');
    expect(completionWords('mysql').keywords).not.toContain('ROWNUM');
    expect(completionWords('mysql').functions).not.toContain('NVL');

    expect(labels('mysql', 'SHO')).toContain('SHOW');
    expect(labels('dm', 'SHO')).not.toContain('SHOW');
    expect(labels('dm', 'ROW')).toContain('ROWNUM');
    expect(labels('mysql', 'ROW')).not.toContain('ROWNUM');
  });

  it('suggests tables after FROM and quotes them for the dialect', () => {
    expect(labels('mysql', 'SELECT * FROM ', '', ['orders', 'users'])).toContain('`orders`');
    expect(labels('dm', 'SELECT * FROM ord', '', ['orders'])).toEqual(['"orders"']);
  });

  it('suggests columns after a table name', () => {
    const target = completionTarget('SELECT * FROM orders.');
    expect(target).toEqual({ kind: 'column', table: 'orders', prefix: '' });
    expect(labels('dm', 'SELECT * FROM orders.', '', [], ['id', 'name'])).toEqual(['"id"', '"name"']);
  });

  it('resolves an alias to its table, including an alias declared later in the statement', () => {
    expect(completionTarget('FROM orders o.')).toEqual({ kind: 'column', table: 'orders', prefix: '' });
    expect(completionTarget('SELECT o.', 'id FROM orders o')).toEqual({
      kind: 'column',
      table: 'orders',
      prefix: '',
    });
    expect(completionTarget('SELECT o.na', ' FROM orders AS o')).toEqual({
      kind: 'column',
      table: 'orders',
      prefix: 'na',
    });
  });

  it('does not complete inside strings or comments', () => {
    expect(completionTarget("SELECT 'SEL")).toBeNull();
    expect(completionTarget('SELECT 1; -- SEL')).toBeNull();
    expect(completionTarget('SELECT /* SEL')).toBeNull();
  });
});
