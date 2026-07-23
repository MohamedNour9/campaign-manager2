import { getProvider, describeProviderError, sanitizeHeaderValue } from './providers';
import { PrismaClient, EmailAccount } from '@prisma/client';
import { decrypt } from './crypto';

const prisma = new PrismaClient();
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Failover order when the account originally chosen for a recipient fails or is rate-limited —
// tries the next provider type down this list before giving up on that recipient.
const PROVIDER_FAILOVER_ORDER = ['smtp', 'brevo', 'sendgrid', 'ses', 'mailgun', 'resend'];

// ---------------------------------------------------------------------------
// Rate / concurrency config
// ---------------------------------------------------------------------------
const RATE_MAX = parseInt(process.env.EMAIL_RATE_MAX || '10');
const RATE_WINDOW_MS = parseInt(process.env.EMAIL_RATE_DURATION_MS || '1000');
const CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------
interface QueueJobData {
  providerType: string; config: any; to: string; subject: string; html: string; text: string;
  fromName: string; campaignId: string | null; recipientId: string | null; accountId: string | null;
}

interface InternalJob {
  id: string;
  data: QueueJobData;
  attemptsMade: number;
  maxAttempts: number;
  backoffDelay: number; // ms
  addedAt: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Signals "nothing is wrong, we're just out of capacity right now" — the
// caller should retry the job automatically later.
// ---------------------------------------------------------------------------
class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

// ---------------------------------------------------------------------------
// In-memory Queue
// ---------------------------------------------------------------------------
class InMemoryQueue {
  private jobs: InternalJob[] = [];
  private processing = false;
  private activeCount = 0;
  private rateTokens = RATE_MAX;
  private lastRateReset = Date.now();
  private processor: (job: InternalJob) => Promise<any>;
  private onFailed: (job: InternalJob, err: Error) => Promise<void>;

  constructor(
    processor: (job: InternalJob) => Promise<any>,
    onFailed: (job: InternalJob, err: Error) => Promise<void>,
  ) {
    this.processor = processor;
    this.onFailed = onFailed;
  }

  add(data: QueueJobData, opts?: { attempts?: number; backoff?: { type: string; delay: number }; removeOnComplete?: number; removeOnFail?: number }): InternalJob {
    const now = Date.now();
    const job: InternalJob = {
      id: `job_${now}_${Math.random().toString(36).slice(2, 8)}`,
      data,
      attemptsMade: 0,
      maxAttempts: opts?.attempts || 5,
      backoffDelay: (opts?.backoff as any)?.delay || 5000,
      addedAt: now,
    };
    this.jobs.push(job);

    // Persist to DB — survives server restarts
    prisma.pendingJob.create({
      data: {
        id: job.id,
        userId: data.accountId || 'owner',
        data: JSON.stringify(job),
        attemptsMade: 0,
        maxAttempts: job.maxAttempts,
        backoffDelay: job.backoffDelay,
        addedAt: new Date(now),
      },
    }).catch(() => {});

    this.scheduleProcessing();
    return job;
  }

  private scheduleProcessing() {
    if (this.processing) return;
    this.processing = true;
    setImmediate(() => this.processNext());
  }

  private async processNext() {
    this.processing = false;

    while (this.activeCount < CONCURRENCY) {
      // Rate limiting: reset token bucket every RATE_WINDOW_MS
      const now = Date.now();
      if (now - this.lastRateReset >= RATE_WINDOW_MS) {
        this.rateTokens = RATE_MAX;
        this.lastRateReset = now;
      }
      if (this.rateTokens <= 0) {
        // Wait until the window resets
        setTimeout(() => this.scheduleProcessing(), Math.max(1, RATE_WINDOW_MS - (now - this.lastRateReset)));
        return;
      }

      // Pick the oldest pending job
      const idx = this.jobs.findIndex(j => j.attemptsMade < j.maxAttempts && !j.timeoutId);
      if (idx === -1) return; // nothing to do

      const job = this.jobs[idx];
      job.timeoutId = undefined; // clear any previous schedule
      this.activeCount++;
      this.rateTokens--;

      this.processor(job)
        .then(async (result) => {
          this.activeCount--;
          // Job succeeded — remove it from queue and DB
          const removeIdx = this.jobs.indexOf(job);
          if (removeIdx !== -1) this.jobs.splice(removeIdx, 1);
          await prisma.pendingJob.delete({ where: { id: job.id } }).catch(() => {});
        })
        .catch(async (err) => {
          this.activeCount--;
          job.attemptsMade++;

          if (job.attemptsMade >= job.maxAttempts) {
            // Final failure — fire the failed handler, remove from queue and DB
            await this.onFailed(job, err).catch(() => {});
            const removeIdx = this.jobs.indexOf(job);
            if (removeIdx !== -1) this.jobs.splice(removeIdx, 1);
            await prisma.pendingJob.delete({ where: { id: job.id } }).catch(() => {});
          } else {
            // Retry with exponential backoff
            const delay = job.backoffDelay * Math.pow(2, job.attemptsMade - 1);
            job.timeoutId = setTimeout(() => {
              this.scheduleProcessing();
            }, delay);
          }
        })
        .finally(() => {
          this.scheduleProcessing();
        });
    }
  }

  getJobCount() {
    return this.jobs.length;
  }

  async close() {
    // Cancel all pending timeouts
    for (const job of this.jobs) {
      if (job.timeoutId) clearTimeout(job.timeoutId);
    }
    this.jobs = [];
    this.processing = false;
    // Wait for active jobs to finish (give them 5s)
    const start = Date.now();
    while (this.activeCount > 0 && Date.now() - start < 5000) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  /**
   * Load persisted jobs from DB and re-add them to the queue.
   * Called once on server startup so pending sends survive a restart.
   */
  async restoreJobsFromDb(): Promise<number> {
    const pending = await prisma.pendingJob.findMany({ orderBy: { addedAt: 'asc' } });
    let restored = 0;
    for (const pj of pending) {
      try {
        const parsed: InternalJob = JSON.parse(pj.data);
        parsed.attemptsMade = pj.attemptsMade;
        parsed.maxAttempts = pj.maxAttempts;
        parsed.backoffDelay = pj.backoffDelay;
        parsed.addedAt = pj.addedAt.getTime();
        // Only re-add if not already completed
        if (parsed.attemptsMade < parsed.maxAttempts && !this.jobs.find(j => j.id === parsed.id)) {
          this.jobs.push(parsed);
          restored++;
        }
      } catch { /* skip corrupted */ }
    }
    if (restored > 0) {
      console.log(`🔄 Restored ${restored} pending job(s) from DB`);
      this.scheduleProcessing();
    }
    return restored;
  }
}

// ---------------------------------------------------------------------------
// Singleton queue instance
// ---------------------------------------------------------------------------
let _queue: InMemoryQueue | null = null;

function getQueue(): InMemoryQueue {
  if (!_queue) {
    _queue = new InMemoryQueue(
      // Processor
      async (job) => {
        const { providerType, config, to, subject, html, text, fromName, campaignId, recipientId, accountId } = job.data;

        // ---- Test-send / one-off path ----
        if (!campaignId) {
          const provider = getProvider(providerType, config);
          await provider.send(to, sanitizeHeaderValue(subject), html, text, sanitizeHeaderValue(fromName));
          return { success: true, testSend: true };
        }

        // ---- Real campaign send: suppression + blocklist guards ----
        const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (campaign) {
          const suppressed = await prisma.suppression.findFirst({ where: { userId: campaign.userId, email: to.toLowerCase() } });
          if (suppressed) {
            if (recipientId) await prisma.recipient.update({ where: { id: recipientId }, data: { status: 'unsubscribed' } });
            return { skipped: true, reason: 'suppressed' };
          }
          const domain = to.split('@')[1];
          const domainBlocked = await prisma.blockedDomain.findFirst({ where: { userId: campaign.userId, domain } });
          if (domainBlocked) {
            if (recipientId) await prisma.recipient.update({ where: { id: recipientId }, data: { status: 'failed', errorMsg: 'نطاق محظور' } });
            return { skipped: true, reason: 'blocked_domain' };
          }
        }

        let finalHtml = html;
        let unsubscribeUrl: string | undefined;
        if (recipientId) {
          const injected = injectTrackingAndUnsubscribe(html, campaignId!, recipientId);
          finalHtml = injected.html;
          unsubscribeUrl = injected.unsubscribeUrl;
        }

        // ---- Build the failover candidate chain ----
        const candidates: EmailAccount[] = [];
        if (accountId) {
          const primary = await prisma.emailAccount.findUnique({ where: { id: accountId } });
          if (primary) {
            candidates.push(primary);
            const others = await prisma.emailAccount.findMany({
              where: { userId: primary.userId, status: 'active', id: { not: primary.id } },
            });
            others.sort((a, b) => PROVIDER_FAILOVER_ORDER.indexOf(a.providerType) - PROVIDER_FAILOVER_ORDER.indexOf(b.providerType));
            candidates.push(...others);
          }
        }
        if (!candidates.length) throw new Error('No email account available to send from');

        let lastError: any = null;
        let usedAccount: EmailAccount | null = null;

        for (const account of candidates) {
          const gotCapacity = await reserveCapacity(account.id);
          if (!gotCapacity) continue;

          try {
            const acctConfig = JSON.parse(decrypt(account.config));
            const provider = getProvider(account.providerType, acctConfig);
            await provider.send(to, sanitizeHeaderValue(subject), finalHtml, text, sanitizeHeaderValue(fromName), unsubscribeUrl);
            usedAccount = account;
            await prisma.emailAccount.update({ where: { id: account.id }, data: { successCount: { increment: 1 } } });
            break;
          } catch (err) {
            lastError = err;
            await releaseCapacity(account.id);
            await prisma.emailAccount.update({ where: { id: account.id }, data: { failureCount: { increment: 1 } } }).catch(() => {});
            continue;
          }
        }

        if (!usedAccount) {
          if (lastError) throw new Error(describeProviderError(lastError));
          throw new RateLimitedError('All accounts are at capacity right now — will retry automatically');
        }

        await prisma.campaign.update({ where: { id: campaignId }, data: { sentCount: { increment: 1 } } });
        if (recipientId) await prisma.recipient.update({ where: { id: recipientId }, data: { status: 'sent', sentAt: new Date() } });
        return { success: true, accountId: usedAccount.id };
      },
      // On-failed handler
      async (job, err) => {
        const { campaignId, recipientId, accountId } = job.data;
        if (recipientId) await prisma.recipient.update({ where: { id: recipientId }, data: { status: 'failed', errorMsg: err.message } }).catch(() => {});
        if (campaignId && accountId) {
          await prisma.sendingLog.create({
            data: { campaignId, recipientId, accountId, status: 'failed', error: err.message, attempts: job.attemptsMade },
          }).catch(() => {});
        }
      },
    );
  }
  return _queue;
}

// ---------------------------------------------------------------------------
// Public API — matches the original BullMQ-based exports exactly
// ---------------------------------------------------------------------------

export const emailQueue = {
  async add(name: string, data: QueueJobData, opts?: any) {
    return getQueue().add(data, opts);
  },
  async close() {
    if (_queue) await _queue.close();
  },
  getJobCount() {
    return _queue?.getJobCount() ?? 0;
  },
  async restoreJobsFromDb() {
    if (_queue) await _queue.restoreJobsFromDb();
  },
};

export const emailWorker = {
  async close() {
    if (_queue) await _queue.close();
  },
};

export async function addEmailToQueue(params: QueueJobData) {
  return emailQueue.add('send-email', params, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

// ---------------------------------------------------------------------------
// Helpers (unchanged from original — all Prisma-based)
// ---------------------------------------------------------------------------

export { RateLimitedError };

/** Warm-up ramp: a fresh account sends far less on day 0 and scales up daily. */
export function computeEffectiveDailyLimit(account: EmailAccount): number {
  if (!account.warmupEnabled || !account.warmupStartAt) return account.dailyLimit;
  const daysElapsed = Math.floor((Date.now() - new Date(account.warmupStartAt).getTime()) / 86400000);
  const ramp = [20, 50, 100, 200, 350];
  const rampLimit = daysElapsed < ramp.length ? ramp[daysElapsed] : account.dailyLimit;
  return Math.min(rampLimit, account.dailyLimit);
}

/** Atomically-ish reserves one unit of daily/hourly/minute capacity on an account. */
async function reserveCapacity(accountId: string): Promise<boolean> {
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account || account.status !== 'active') return false;

  const now = new Date();
  const resets: any = {};
  let { sentToday, sentThisMinute, sentThisHour } = account;
  if (now.getTime() - new Date(account.lastReset).getTime() >= 86400000) { sentToday = 0; resets.sentToday = 0; resets.lastReset = now; }
  if (now.getTime() - new Date(account.minuteReset).getTime() >= 60000) { sentThisMinute = 0; resets.sentThisMinute = 0; resets.minuteReset = now; }
  if (now.getTime() - new Date(account.hourReset).getTime() >= 3600000) { sentThisHour = 0; resets.sentThisHour = 0; resets.hourReset = now; }

  const effectiveDailyLimit = computeEffectiveDailyLimit(account);
  if (sentToday >= effectiveDailyLimit || sentThisMinute >= account.perMinuteLimit || sentThisHour >= account.perHourLimit) {
    if (Object.keys(resets).length) await prisma.emailAccount.update({ where: { id: accountId }, data: resets });
    return false;
  }

  await prisma.emailAccount.update({
    where: { id: accountId },
    data: { ...resets, sentToday: sentToday + 1, sentThisMinute: sentThisMinute + 1, sentThisHour: sentThisHour + 1, lastUsedAt: now },
  });
  return true;
}

async function releaseCapacity(accountId: string) {
  await prisma.emailAccount.update({
    where: { id: accountId },
    data: { sentToday: { decrement: 1 }, sentThisMinute: { decrement: 1 }, sentThisHour: { decrement: 1 } },
  }).catch(() => {});
}

/** Rewrites tracked links, appends the open-tracking pixel, AND appends a visible unsubscribe footer. */
function injectTrackingAndUnsubscribe(html: string, campaignId: string, recipientId: string) {
  const unsubscribeUrl = `${APP_URL}/unsubscribe/${campaignId}/${recipientId}`;
  let out = html.replace(/href="(https?:\/\/[^"]+)"/g, (_m, url) =>
    `href="${APP_URL}/t/click/${campaignId}/${recipientId}?url=${encodeURIComponent(url)}"`);
  out += `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #ddd;font-size:12px;color:#888;text-align:center">
    <a href="${unsubscribeUrl}" style="color:#888">إلغاء الاشتراك من هذه القائمة</a>
  </div>`;
  out += `<img src="${APP_URL}/t/open/${campaignId}/${recipientId}" width="1" height="1" style="display:none" alt=""/>`;
  return { html: out, unsubscribeUrl };
}
