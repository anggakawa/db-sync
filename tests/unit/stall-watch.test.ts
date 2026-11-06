import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchStall } from '../../src/main/sync/stall-watch';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('watchStall', () => {
  it('fires once when the measure stays flat for the limit', async () => {
    const onStall = vi.fn();
    watchStall(async () => 100, 30_000, onStall, 10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('resets when the value grows', async () => {
    let size = 0;
    const onStall = vi.fn();
    watchStall(async () => size, 30_000, onStall, 10_000);
    for (let i = 0; i < 6; i++) { size += 10; await vi.advanceTimersByTimeAsync(10_000); }
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('stops polling after dispose', async () => {
    const measure = vi.fn(async () => 1);
    const onStall = vi.fn();
    const stop = watchStall(measure, 30_000, onStall, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    const calls = measure.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(measure.mock.calls.length).toBe(calls);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('counts a failing measure as no growth', async () => {
    const onStall = vi.fn();
    watchStall(async () => { throw new Error('gone'); }, 20_000, onStall, 10_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });
});
