import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WikiRateLimiter } from './rateLimiter';

describe('WikiRateLimiter', () => {
    beforeEach(() => {
        WikiRateLimiter.resetForTests();
    });

    it('runs jobs serially in order', async () => {
        const limiter = WikiRateLimiter.getInstance({
            requestsPerMinute: 100,
            minIntervalMs: 0,
            maxRetries: 0,
        });
        limiter.resetSessionBudget(10);
        const order: number[] = [];
        const p1 = limiter.schedule(async () => {
            order.push(1);
            return { result: 1, status: 200, durationMs: 0 };
        });
        const p2 = limiter.schedule(async () => {
            order.push(2);
            return { result: 2, status: 200, durationMs: 0 };
        });
        await Promise.all([p1, p2]);
        expect(order).toEqual([1, 2]);
    });

    it('stops when session budget exhausted', async () => {
        const limiter = WikiRateLimiter.getInstance({
            requestsPerMinute: 100,
            minIntervalMs: 0,
            maxRetries: 0,
        });
        limiter.resetSessionBudget(1);
        let calls = 0;
        const r1 = await limiter.schedule(async () => {
            calls++;
            return { result: 'a', status: 200, durationMs: 0 };
        });
        const r2 = await limiter.schedule(async () => {
            calls++;
            return { result: 'b', status: 200, durationMs: 0 };
        });
        expect(r1).toBe('a');
        expect(r2).toBeNull();
        expect(calls).toBe(1);
    });

    it('retries on 429 then succeeds', async () => {
        const limiter = WikiRateLimiter.getInstance({
            requestsPerMinute: 100,
            minIntervalMs: 0,
            maxRetries: 2,
            backoffBaseMs: 1,
            backoffMaxMs: 10,
        });
        limiter.resetSessionBudget(5);
        let attempts = 0;
        const result = await limiter.schedule(async () => {
            attempts++;
            if (attempts === 1) {
                return { result: null, status: 429, retryAfterSec: 0, durationMs: 0 };
            }
            return { result: 'ok', status: 200, durationMs: 0 };
        });
        expect(result).toBe('ok');
        expect(attempts).toBe(2);
    });
});
