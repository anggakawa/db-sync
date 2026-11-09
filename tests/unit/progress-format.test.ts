import { describe, expect, it } from 'vitest';
import {
  bytesProgressLabel, dumpTablesLabel, formatCount, formatSize, readingLabel, restoreBytesLabel, restoreTablesLabel,
} from '../../src/main/engines/progress-format';

describe('formatCount', () => {
  it('uses thousands separators', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1317)).toBe('1,317');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});

describe('formatSize', () => {
  it('is 1024-based, with one decimal from MB up', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(512 * 1024)).toBe('512 KB');
    expect(formatSize(1536)).toBe('2 KB');
    expect(formatSize(Math.round(48.3 * 1024 * 1024))).toBe('48.3 MB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(Math.round(2.3 * 1024 ** 3))).toBe('2.3 GB');
  });
  it('never shows 1024 of a smaller unit', () => {
    expect(formatSize(1024 * 1024 - 1)).toBe('1.0 MB');
  });
});

describe('labels', () => {
  it('shows finished tables and size for a dump', () => {
    expect(dumpTablesLabel('Downloading from dev', 1317, 1400, 2.3 * 1024 ** 3))
      .toBe('Downloading from dev: 1,317 of 1,400 tables, 2.3 GB so far');
    expect(dumpTablesLabel('Backing up local data', 3, 12, 512 * 1024)).toBe('Backing up local data: 3 of 12 tables, 512 KB so far');
  });
  it('shows finished tables for a restore', () => {
    expect(restoreTablesLabel(2, 1317)).toBe('Restoring: 2 of 1,317 tables');
  });
  it('says what is being read before any table finishes', () => {
    expect(readingLabel('dev')).toBe('Reading the table list from dev...');
    expect(readingLabel('the local database')).toBe('Reading the table list from the local database...');
  });
  it('shows bytes for the single-file engines', () => {
    expect(bytesProgressLabel('Downloading from dev', 48.3 * 1024 * 1024, 100 * 1024 * 1024)).toBe('Downloading from dev: 48.3 MB of about 100.0 MB');
    expect(restoreBytesLabel(1024 * 1024, 4 * 1024 * 1024)).toBe('Restoring: 1.0 MB of 4.0 MB');
  });
});
