/** Wikimedia API 串行限速与运行预算（扩展进程内单例） */

export interface WikiRateLimiterConfig {
    requestsPerMinute: number;
    minIntervalMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    pauseAfter429Ms: number;
}

export interface WikiRequestBudget {
    used: number;
    max: number;
}

export class WikiRateLimiter {
    private static instance: WikiRateLimiter | null = null;

    private chain: Promise<unknown> = Promise.resolve();
    private requestTimestamps: number[] = [];
    private lastRequestAt = 0;
    private pausedUntil = 0;
    private consecutive429 = 0;
    private config: WikiRateLimiterConfig;
    private budget: WikiRequestBudget = { used: 0, max: Number.MAX_SAFE_INTEGER };

    private constructor(config: WikiRateLimiterConfig) {
        this.config = config;
    }

    static getInstance(config?: Partial<WikiRateLimiterConfig>): WikiRateLimiter {
        if (!WikiRateLimiter.instance) {
            WikiRateLimiter.instance = new WikiRateLimiter({
                requestsPerMinute: config?.requestsPerMinute ?? 30,
                minIntervalMs: config?.minIntervalMs ?? 200,
                maxRetries: config?.maxRetries ?? 3,
                backoffBaseMs: config?.backoffBaseMs ?? 5000,
                backoffMaxMs: config?.backoffMaxMs ?? 120000,
                pauseAfter429Ms: config?.pauseAfter429Ms ?? 60000,
            });
        } else if (config) {
            WikiRateLimiter.instance.updateConfig(config);
        }
        return WikiRateLimiter.instance;
    }

    /** 测试用：重置单例 */
    static resetForTests(): void {
        WikiRateLimiter.instance = null;
    }

    updateConfig(partial: Partial<WikiRateLimiterConfig>): void {
        this.config = { ...this.config, ...partial };
    }

    resetSessionBudget(max: number): void {
        this.budget = { used: 0, max };
        this.consecutive429 = 0;
        this.pausedUntil = 0;
    }

    getBudget(): WikiRequestBudget {
        return { ...this.budget };
    }

    isPaused(): boolean {
        return Date.now() < this.pausedUntil;
    }

    isBudgetExhausted(): boolean {
        return this.budget.used >= this.budget.max;
    }

    /** 串行执行 HTTP 任务；网络请求计入 budget，cache 命中不应调用此方法 */
    async schedule<T>(
        fn: () => Promise<{ result: T; status: number; retryAfterSec?: number; durationMs: number }>,
        options?: { countAsRequest?: boolean }
    ): Promise<T | null> {
        const countAsRequest = options?.countAsRequest !== false;
        if (this.isBudgetExhausted()) {
            return null;
        }
        const run = async (): Promise<T | null> => {
            if (this.isPaused()) {
                await sleep(Math.max(0, this.pausedUntil - Date.now()));
            }
            await this.waitForSlot();
            if (countAsRequest && this.isBudgetExhausted()) {
                return null;
            }

            let attempt = 0;
            while (attempt <= this.config.maxRetries) {
                attempt++;
                const started = Date.now();
                try {
                    const { result, status, retryAfterSec, durationMs } = await fn();
                    if (status === 429 || status === 503) {
                        this.consecutive429++;
                        if (this.consecutive429 >= 2) {
                            this.pausedUntil = Date.now() + this.config.pauseAfter429Ms;
                        }
                        const waitMs = retryAfterSec
                            ? retryAfterSec * 1000
                            : Math.min(
                                  this.config.backoffMaxMs,
                                  this.config.backoffBaseMs * Math.pow(2, attempt - 1)
                              );
                        await sleep(waitMs);
                        continue;
                    }
                    this.consecutive429 = 0;
                    if (countAsRequest) {
                        this.budget.used++;
                    }
                    if (durationMs > 1000) {
                        await sleep(5000);
                    }
                    return result;
                } catch {
                    if (attempt > this.config.maxRetries) {
                        return null;
                    }
                    await sleep(
                        Math.min(this.config.backoffMaxMs, this.config.backoffBaseMs * Math.pow(2, attempt - 1))
                    );
                } finally {
                    const elapsed = Date.now() - started;
                    if (elapsed < this.config.minIntervalMs) {
                        await sleep(this.config.minIntervalMs - elapsed);
                    }
                }
            }
            return null;
        };

        const p = this.chain.then(run, run);
        this.chain = p.then(
            () => undefined,
            () => undefined
        );
        return p;
    }

    private async waitForSlot(): Promise<void> {
        const now = Date.now();
        const windowMs = 60_000;
        this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < windowMs);
        while (this.requestTimestamps.length >= this.config.requestsPerMinute) {
            const oldest = this.requestTimestamps[0] ?? now;
            const wait = windowMs - (now - oldest) + 50;
            await sleep(Math.max(this.config.minIntervalMs, wait));
            const n = Date.now();
            this.requestTimestamps = this.requestTimestamps.filter((t) => n - t < windowMs);
        }
        if (this.lastRequestAt > 0) {
            const gap = now - this.lastRequestAt;
            if (gap < this.config.minIntervalMs) {
                await sleep(this.config.minIntervalMs - gap);
            }
        }
        this.lastRequestAt = Date.now();
        this.requestTimestamps.push(this.lastRequestAt);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
