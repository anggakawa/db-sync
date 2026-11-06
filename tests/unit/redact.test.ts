import { describe, expect, it } from 'vitest';
import { cleanEnv, redact } from '../../src/main/process/redact';

describe('redact', () => {
  it('redacts every secret, longest first', () => {
    expect(redact('a=hunter22 b=hunter2', ['hunter2', 'hunter22', ''])).toBe('a=*** b=***');
  });
  it('leaves text alone when there are no secrets', () => {
    expect(redact('nothing here', ['', ''])).toBe('nothing here');
  });
  it('treats secrets literally, not as patterns', () => {
    expect(redact('pw=a.c+(x) and abc', ['a.c+(x)'])).toBe('pw=*** and abc');
  });
});

describe('cleanEnv', () => {
  it('drops inherited database variables', () => {
    expect(cleanEnv({ PGHOST: 'x', PGPASSWORD: 'x', MYSQL_PWD: 'x', mariadb_x: 'y', PATH: 'p' })).toEqual({ PATH: 'p' });
  });
  it('drops undefined values', () => {
    expect(cleanEnv({ A: undefined, B: 'b' })).toEqual({ B: 'b' });
  });
});
