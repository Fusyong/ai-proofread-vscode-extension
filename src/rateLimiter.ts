/**
 * 限速器类，用于控制API调用频率
 */
export class RateLimiter {
    private interval: number;
    private lastCallTime: number;

    constructor(rpm: number) {
        this.interval = 60 / rpm;
        this.lastCallTime = 0;
    }

    async wait(): Promise<void> {
        const currentTime = Date.now() / 1000;
        const elapsed = currentTime - this.lastCallTime;
        if (elapsed < this.interval) {
            const waitTime = this.interval - elapsed;
            await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
        }
        this.lastCallTime = Date.now() / 1000;
    }
}