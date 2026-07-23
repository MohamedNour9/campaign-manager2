import { RateLimitedError, computeEffectiveDailyLimit } from '../queue';

describe('queue', () => {
  describe('RateLimitedError', () => {
    it('extends Error with the correct name', () => {
      const err = new RateLimitedError('too fast');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('RateLimitedError');
      expect(err.message).toBe('too fast');
    });
  });

  describe('computeEffectiveDailyLimit', () => {
    const baseAccount: any = {
      dailyLimit: 300,
      warmupEnabled: false,
      warmupStartAt: null,
    };

    it('returns the full dailyLimit when warmup is not enabled', () => {
      expect(computeEffectiveDailyLimit(baseAccount)).toBe(300);
    });

    it('returns the full dailyLimit when warmupStartAt is null', () => {
      expect(computeEffectiveDailyLimit({ ...baseAccount, warmupEnabled: true })).toBe(300);
    });

    it('returns 20 on day 0 of warmup', () => {
      const now = Date.now();
      const account = { ...baseAccount, warmupEnabled: true, warmupStartAt: new Date(now) };
      expect(computeEffectiveDailyLimit(account)).toBe(20);
    });

    it('returns 50 on day 1 of warmup', () => {
      const yesterday = new Date(Date.now() - 86400000);
      const account = { ...baseAccount, warmupEnabled: true, warmupStartAt: yesterday };
      expect(computeEffectiveDailyLimit(account)).toBe(50);
    });

    it('returns 100 on day 2 of warmup', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
      const account = { ...baseAccount, warmupEnabled: true, warmupStartAt: twoDaysAgo };
      expect(computeEffectiveDailyLimit(account)).toBe(100);
    });

    it('caps warmup ramp at the configured dailyLimit', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
      const account = { ...baseAccount, warmupEnabled: true, warmupStartAt: twoDaysAgo, dailyLimit: 80 };
      // ramp says 100, but dailyLimit is 80, so cap at 80
      expect(computeEffectiveDailyLimit(account)).toBe(80);
    });
  });
});
