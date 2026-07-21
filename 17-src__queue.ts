import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { getProvider, describeProviderError, sanitizeHeaderValue } from './providers';
import { PrismaClient, EmailAccount } from '@prisma/client';
import { decrypt } from './crypto';

const prisma = new PrismaClient();
const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
export const emailQueue = new Queue('emailQueue', { connection });
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Conservative default: 10 sends/second across all accounts combined. Override via env
// if your providers can handle more (or need less, e.g. Gmail SMTP is much stricter).
const RATE_MAX = parseInt(process.env.EMAIL_RATE_MAX || '10');
const RATE_DURATION_MS = parseInt(process.env.EMAIL_RATE_DURATION_MS || '1000');

// Failover order when the account originally chosen for a recipient fails or is rate-limited —
// tries the next provider type down this list before giving up on that recipient.
const PROVIDER_FAILOVER_ORDER = ['smtp', 'brevo', 'sendgrid', 'ses', 'mailgun', 'resend'];

interface QueueJobData {
  providerType: string; config: any; to: string; subject: string; html: string; text: string;
  fromName: string; campaignId: string | null; recipientId: string | null; accountId: string | null;
}

export async function addEmailToQueue(params: QueueJobData) {
  return emailQueue.add('send-email', params, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

// Signals "nothing is wrong, we're just out of capacity right now" — BullMQ will retry
// this job later via its normal backoff instead of marking the recipient permanently failed.
class RateLimitedError extends Error {}

// Warm-up ramp: a fresh account sends far less on day 0 and scales up daily, capped at
// whatever dailyLimit the person configured. Ignored once warmupEnabled is off.
function computeEffectiveDailyLimit(account: EmailAccount): number {
  if (!account.warmupEnabled || !account.warmupStartAt) return account.dailyLimit;
  const daysElapsed = Math.floor((Date.now() - new Date(account.warmupStartAt).getTime()) / 86400000);
  const ramp = [20, 50, 100, 200, 350];
  const rampLimit = daysElapsed < ramp.length ? ramp[daysElapsed] : account.dailyLimit;
  return Math.min(rampLimit, account.dailyLimit);
}

// Atomically-ish reserves one unit of daily/hourly/minute capacity on an account.
// Returns false (no throw) if the account is out of capacity right now — the caller
// should try the next account in the failover chain rather than treating this as an error.
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
  // Send actually failed after we reserved capacity — give that slot back so a real
  // failure doesn't unfairly eat into the account's rate limit.
  await prisma.emailAccount.update({
    where: { id: accountId },
    data: { sentToday: { decrement: 1 }, sentThisMinute: { decrement: 1 }, sentThisHour: { decrement: 1 } },
  }).catch(() => {}); // best-effort — never let bookkeeping errors mask the real send error
}

// Rewrites tracked links, appends the open-tracking pixel, AND appends a visible
// unsubscribe footer (required for deliverability + compliance — Gmail/Yahoo will
// junk-folder or reject bulk mail that has no unsubscribe mechanism).
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

export const emailWorker = new Worker('emailQueue', async (job) => {
  const { providerType, config, to, subject, html, text, fromName, campaignId, recipientId, accountId } = job.data as QueueJobData;

  // ---- Test-send / one-off path: no failover, no capacity tracking (matches the
  // "doesn't touch campaign counters" contract of the test-send endpoint) ----
  if (!campaignId) {
    const provider = getProvider(providerType, config);
    try {
      await provider.send(to, sanitizeHeaderValue(subject), html, text, sanitizeHeaderValue(fromName));
    } catch (err) {
      throw new Error(describeProviderError(err));
    }
    return { success: true, testSend: true };
  }

  // ---- Real campaign send: suppression + blocklist guards first ----
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
    const injected = injectTrackingAndUnsubscribe(html, campaignId, recipientId);
    finalHtml = injected.html;
    unsubscribeUrl = injected.unsubscribeUrl;
  }

  // ---- Build the failover candidate chain: originally-assigned account first, then
  // every other active account for this user, ordered by the provider preference list ----
  const candidates: EmailAccount[] = [];
  if (accountId) {
    const primary = await prisma.emailAccount.findUnique({ where: { id: accountId } });
    if (primary) {
      candidates.push(primary);
      const others = await prisma.emailAccount.findMany({ where: { userId: primary.userId, status: 'active', id: { not: primary.id } } });
      others.sort((a, b) => PROVIDER_FAILOVER_ORDER.indexOf(a.providerType) - PROVIDER_FAILOVER_ORDER.indexOf(b.providerType));
      candidates.push(...others);
    }
  }
  if (!candidates.length) throw new Error('No email account available to send from');

  let lastError: any = null;
  let usedAccount: EmailAccount | null = null;

  for (const account of candidates) {
    const gotCapacity = await reserveCapacity(account.id);
    if (!gotCapacity) continue; // rate-limited / warming up — try the next account

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
      continue; // try the next account in the failover chain
    }
  }

  if (!usedAccount) {
    if (lastError) throw new Error(describeProviderError(lastError));
    throw new RateLimitedError('All accounts are at capacity right now — will retry automatically');
  }

  await prisma.campaign.update({ where: { id: campaignId }, data: { sentCount: { increment: 1 } } });
  if (recipientId) await prisma.recipient.update({ where: { id: recipientId }, data: { status: 'sent', sentAt: new Date() } });
  return { success: true, accountId: usedAccount.id };
}, {
  connection,
  concurrency: 5,
  limiter: { max: RATE_MAX, duration: RATE_DURATION_MS },
});

emailWorker.on('failed', async (job, err) => {
  if (!job) return;
  const { campaignId, recipientId, accountId } = job.data as QueueJobData;
  if (job.attemptsMade >= (job.opts.attempts || 1)) {
    if (recipientId) await prisma.recipient.update({ where: { id: recipientId }, data: { status: 'failed', errorMsg: err.message } });
    if (campaignId && accountId) {
      await prisma.sendingLog.create({ data: { campaignId, recipientId, accountId, status: 'failed', error: err.message, attempts: job.attemptsMade } });
    }
  }
});
