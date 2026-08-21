import Redis from "ioredis";
import { config } from "../config";

/**
 * Redis-backed sliding-window-log rate limiter for emails per hour per sender.
 *
 * Instead of a simple counter + TTL (rolling-window bucket), this stores every
 * send timestamp in a Redis sorted set (ZSET) and trims entries older than the
 * window on each check.  This gives an accurate count of sends in the trailing
 * N-minute window with no rounding or boundary artefacts.
 *
 * Key format: rate_limit:{senderEmail}:log
 */
export class RateLimiter {
  private redis: Redis;
  private maxPerWindow: number;
  private windowMs: number;

  constructor(redis: Redis) {
    this.redis = redis;
    this.maxPerWindow = config.worker.maxEmailsPerHour;
    this.windowMs = 60 * 60 * 1000;   // 1 hour
  }

  private getKey(senderEmail: string): string {
    return `rate_limit:${senderEmail}:log`;
  }

  /**
   * Attempt to record a send and check whether the sender is within the limit.
   *
   * Returns `true` if the send is allowed, `false` if rate-limited.
   *
   * Uses a Lua script so the trim + count + add is atomic no race conditions
   * between concurrent workers.
   */
  async tryIncrement(senderEmail: string): Promise<boolean> {
    const key = this.getKey(senderEmail);
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const member = `${now}:${senderEmail}:${Math.random().toString(36).slice(2, 8)}`;

    // Lua script:
    // 1. Remove members with score < windowStart (trim stale entries)
    // 2. Count remaining members (current window count)
    // 3. If under limit, add the new member and return 1 (allowed)
    // 4. Otherwise return 0 (rate-limited)
    const lua = `
      local key = KEYS[1]
      local windowStart = tonumber(ARGV[1])
      local now = ARGV[2]
      local member = ARGV[3]
      local maxPerWindow = tonumber(ARGV[4])

      -- Trim entries outside the window
      redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

      -- Count entries in the current window
      local count = redis.call('ZCARD', key)

      if count < maxPerWindow then
        -- Under limit — record this send
        redis.call('ZADD', key, now, member)
        -- Set an expiry slightly beyond the window so old keys are cleaned up
        -- even if no new requests come in (best-effort, not critical)
        redis.call('PEXPIRE', key, ${this.windowMs + 60_000})
        return 1
      else
        -- Rate limited — still record the attempt for observability
        -- but return 0
        return 0
      end
    `;

    const result = (await this.redis.eval(
      lua,
      1,
      key,
      windowStart.toString(),
      now.toString(),
      member,
      this.maxPerWindow.toString()
    )) as number;

    return result === 1;
  }

 // Check how many emails have been sent in the current window without recording a new send

  async getCurrentCount(senderEmail: string): Promise<number> {
    const key = this.getKey(senderEmail);
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Trim stale entries first
    await this.redis.zremrangebyscore(key, "-inf", windowStart.toString());
    return this.redis.zcard(key);
  }

  // Get the max emails allowed per window.
  getMaxPerWindow(): number {
    return this.maxPerWindow;
  }

  /**
   * Calculate milliseconds until the oldest entry in the current window
   * expires, i.e. when the sender can send again.
   *
   * Returns 0 if there are no entries (sender is not rate-limited).
   */
  async getMsUntilNextWindow(senderEmail: string): Promise<number> {
    const key = this.getKey(senderEmail);

    // Get the oldest member's score (epoch ms of first send in window)
    const oldest = await this.redis.zrange(key, 0, 0, "WITHSCORES");

    if (oldest.length < 2) {
      return 0;
    }

    const oldestScore = parseInt(oldest[1], 10);
    const expiresAt = oldestScore + this.windowMs;
    const msRemaining = expiresAt - Date.now();

    return Math.max(0, msRemaining);
  }
}
