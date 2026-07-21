import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { PrismaClient } from '@prisma/client';
import { addEmailToQueue } from './queue';
import { requireUnlock, attachOwner, ensureOwnerSeeded, checkUnlockPassword, AuthedRequest } from './auth';
import { encrypt, decrypt } from './crypto';
import { parseRecipientFile, isValidEmail, DISPOSABLE_DOMAINS, mergeTemplate, ParsedRecipient } from './upload';
import { getProvider } from './providers';
import multer from 'multer';
import { swaggerSpec } from './swagger';

dotenv.config();
const app = express();
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false })); // CSP off: swagger-ui and inline scripts need it relaxed; fine for a single-user internal tool
app.use(cors());
// 5mb is generous for a campaign's HTML/text body — CSV uploads go through multipart (25mb limit above), not JSON
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Brute-force protection on the one password gate: 10 attempts per 15 minutes per IP
const unlockLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'محاولات كثيرة جدًا — حاول بعد 15 دقيقة' } });

// General safety net on the API surface (tracking pixels/unsubscribe links stay unlimited —
// those are clicked by real recipients, not by whoever holds the app password)
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

// ---- No login system: every request is automatically the single owner account ----
// ---- Optional single shared-password gate (set APP_PASSWORD env var to enable) ----
app.post('/api/unlock', unlockLimiter, (req, res) => {
  const token = checkUnlockPassword(req.body?.password || '');
  if (!token) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token, locked: !!process.env.APP_PASSWORD });
});

// ---- Accounts (config encrypted at rest, never returned to client) ----
app.get('/api/accounts', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const accounts = await prisma.emailAccount.findMany({ where: { userId: req.userId! } });
  res.json(accounts.map(({ config, ...rest }) => rest));
});

const REQUIRED_CONFIG_FIELDS: Record<string, string[]> = {
  smtp: ['host', 'port', 'username', 'password', 'fromEmail'],
  brevo: ['apiKey', 'fromEmail'],
  ses: ['region', 'smtpUsername', 'smtpPassword', 'fromEmail'],
  mailgun: ['apiKey', 'domain', 'fromEmail'],
  sendgrid: ['apiKey', 'fromEmail'],
  resend: ['apiKey', 'fromEmail'],
};

// ---- Test a provider connection BEFORE saving it (real SMTP handshake / API check,
// no simulation) — lets the UI show a real pass/fail before persisting anything ----
app.post('/api/accounts/test-connection', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const { providerType, config } = req.body;
  if (!providerType || !config) return res.status(400).json({ error: 'providerType and config are required' });
  const required = REQUIRED_CONFIG_FIELDS[providerType];
  if (!required) return res.status(400).json({ error: `Unknown providerType: ${providerType}` });
  const missing = required.filter(f => !config[f]);
  if (missing.length) return res.status(400).json({ ok: false, message: `ناقص: ${missing.join(', ')}` });

  try {
    const provider = getProvider(providerType, config);
    const result = await provider.verify();
    res.json(result);
  } catch (err: any) {
    res.json({ ok: false, message: err.message || 'فشل غير متوقع' });
  }
});

app.post('/api/accounts', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const { providerType, name, config, dailyLimit } = req.body;
  if (!providerType || !config) return res.status(400).json({ error: 'providerType and config are required' });
  const required = REQUIRED_CONFIG_FIELDS[providerType];
  if (!required) return res.status(400).json({ error: `Unknown providerType: ${providerType}` });
  const missing = required.filter(f => !config[f]);
  if (missing.length) return res.status(400).json({ error: `Missing required config fields for ${providerType}: ${missing.join(', ')}` });

  const account = await prisma.emailAccount.create({
    data: { userId: req.userId!, providerType, name, config: encrypt(JSON.stringify(config)), dailyLimit: dailyLimit || 500 }
  });
  const { config: _c, ...safe } = account;
  res.json(safe);
});

app.delete('/api/accounts/:id', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  await prisma.emailAccount.deleteMany({ where: { id: req.params.id, userId: req.userId! } });
  res.json({ success: true });
});

// ---- Test Connection: really checks the provider (SMTP handshake / API key validity) ----
app.post('/api/accounts/:id/test', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const account = await prisma.emailAccount.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!account) return res.status(404).json({ error: 'Not found' });
  const config = JSON.parse(decrypt(account.config));
  const provider = getProvider(account.providerType, config);
  const result = await provider.verify();
  await prisma.emailAccount.update({
    where: { id: account.id },
    data: { connectionStatus: result.ok ? 'healthy' : 'unhealthy', lastTestedAt: new Date() },
  });
  res.json(result);
});

// ---- Enable / disable / adjust an account (rate limits, warmup, status) ----
app.patch('/api/accounts/:id', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const { status, dailyLimit, perMinuteLimit, perHourLimit, warmupEnabled } = req.body;
  const data: any = {};
  if (status !== undefined) data.status = status;
  if (dailyLimit !== undefined) data.dailyLimit = dailyLimit;
  if (perMinuteLimit !== undefined) data.perMinuteLimit = perMinuteLimit;
  if (perHourLimit !== undefined) data.perHourLimit = perHourLimit;
  if (warmupEnabled !== undefined) data.warmupEnabled = warmupEnabled;
  if (warmupEnabled === true) data.warmupStartAt = new Date();
  const account = await prisma.emailAccount.updateMany({ where: { id: req.params.id, userId: req.userId! }, data });
  if (!account.count) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ---- DNS health check: real lookups, no third-party service needed ----
app.get('/api/dns-check', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const domain = (req.query.domain as string || '').trim();
  const selector = (req.query.selector as string) || 'default';
  if (!domain) return res.status(400).json({ error: 'domain query param is required' });

  const dns = await import('dns');
  const resolveTxt = (h: string) => new Promise<string[][]>((resolve) => dns.resolveTxt(h, (err, records) => resolve(err ? [] : records)));
  const resolveMx = (h: string) => new Promise<any[]>((resolve) => dns.resolveMx(h, (err, records) => resolve(err ? [] : records)));

  const [spfRecords, dmarcRecords, dkimRecords, mxRecords] = await Promise.all([
    resolveTxt(domain),
    resolveTxt(`_dmarc.${domain}`),
    resolveTxt(`${selector}._domainkey.${domain}`),
    resolveMx(domain),
  ]);

  const spf = spfRecords.map(r => r.join('')).find(r => r.startsWith('v=spf1'));
  const dmarc = dmarcRecords.map(r => r.join('')).find(r => r.startsWith('v=DMARC1'));
  const dkim = dkimRecords.map(r => r.join('')).find(r => r.includes('v=DKIM1'));

  res.json({
    domain,
    spf: { found: !!spf, record: spf || null },
    dmarc: { found: !!dmarc, record: dmarc || null },
    dkim: { found: !!dkim, record: dkim || null, note: `تم البحث بـ selector "${selector}" — لو مالكش هذا الاسم، جرب selector المزود الفعلي` },
    mx: { found: mxRecords.length > 0, records: mxRecords.map((r: any) => ({ exchange: r.exchange, priority: r.priority })) },
    overallHealthy: !!spf && !!dmarc && mxRecords.length > 0,
  });
});

app.post('/api/upload', requireUnlock, attachOwner, upload.array('files'), async (req: AuthedRequest, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  const blocked = new Set((await prisma.blockedDomain.findMany({ where: { userId: req.userId! } })).map(b => b.domain));

  let all: ParsedRecipient[] = [];
  for (const file of files) all.push(...parseRecipientFile(file.buffer.toString('utf-8')));

  const seen = new Set<string>();
  const valid: ParsedRecipient[] = [];
  const domainCounts: Record<string, number> = {};
  let invalid = 0, duplicate = 0, disposable = 0, blockedCount = 0;

  for (const r of all) {
    if (!isValidEmail(r.email)) { invalid++; continue; }
    const domain = r.email.split('@')[1];
    if (DISPOSABLE_DOMAINS.has(domain)) { disposable++; continue; }
    if (blocked.has(domain)) { blockedCount++; continue; }
    if (seen.has(r.email)) { duplicate++; continue; }
    seen.add(r.email);
    valid.push(r);
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
  }

  const domainBreakdown = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .reduce((acc, [d, n]) => ({ ...acc, [d]: n }), {} as Record<string, number>);

  res.json({
    totalFound: all.length, total: valid.length, recipients: valid,
    rejected: { invalid, duplicate, disposable, blocked: blockedCount },
    domainBreakdown,
  });
});

// ---- Blocked domains (segment-wide blocklist, separate from per-email unsubscribes) ----
app.get('/api/blocked-domains', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  res.json(await prisma.blockedDomain.findMany({ where: { userId: req.userId! } }));
});
app.post('/api/blocked-domains', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const domain = (req.body?.domain || '').toLowerCase().trim();
  if (!domain) return res.status(400).json({ error: 'domain is required' });
  const entry = await prisma.blockedDomain.upsert({
    where: { userId_domain: { userId: req.userId!, domain } },
    update: {}, create: { userId: req.userId!, domain, reason: req.body?.reason },
  });
  res.json(entry);
});
app.delete('/api/blocked-domains/:id', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  await prisma.blockedDomain.deleteMany({ where: { id: req.params.id, userId: req.userId! } });
  res.json({ success: true });
});

// ---- Campaigns ----
app.post('/api/campaigns', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const { name, subject, senderName, htmlContent, textContent, emails, recipients, scheduleAt, tagFilter } = req.body;

  // Accept either the new structured `recipients` array or the old plain `emails` array.
  let incoming: ParsedRecipient[] = recipients?.length
    ? recipients
    : (emails || []).map((e: string) => ({ email: e }));
  if (!incoming.length) return res.status(400).json({ error: 'At least one recipient is required' });

  if (tagFilter) incoming = incoming.filter(r => r.tag === tagFilter);

  const suppressed = new Set((await prisma.suppression.findMany({ where: { userId: req.userId! } })).map(s => s.email));
  const seen = new Set<string>();
  const cleanRecipients = incoming.filter(r => {
    const email = r.email.toLowerCase().trim();
    if (suppressed.has(email) || seen.has(email)) return false;
    seen.add(email);
    return true;
  });
  if (!cleanRecipients.length) return res.status(400).json({ error: 'No valid recipients left after filtering suppressed/duplicate addresses' });

  const campaign = await prisma.campaign.create({
    data: {
      userId: req.userId!, name, subject, senderName, htmlContent, textContent,
      totalEmails: cleanRecipients.length,
      scheduledAt: scheduleAt ? new Date(scheduleAt) : null,
      status: scheduleAt ? 'scheduled' : 'draft',
      recipients: {
        create: cleanRecipients.map(r => ({
          email: r.email.toLowerCase().trim(),
          firstName: r.firstName, lastName: r.lastName, company: r.company,
          tag: r.tag, priority: r.priority || 0,
          customFields: r.customFields ? JSON.stringify(r.customFields) : null,
          status: 'pending',
        }))
      }
    }
  });
  res.json({ id: campaign.id, totalEmails: cleanRecipients.length, skipped: incoming.length - cleanRecipients.length });
});

app.get('/api/campaigns', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const campaigns = await prisma.campaign.findMany({ where: { userId: req.userId! }, orderBy: { id: 'desc' }, take: 100 });
  res.json(campaigns);
});

async function startCampaign(userId: string, campaignId: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, userId }, include: { recipients: true } });
  if (!campaign) return { error: 'Not found', status: 404 };

  const accounts = await prisma.emailAccount.findMany({ where: { userId, status: 'active' } });
  if (!accounts.length) return { error: 'No active email accounts found', status: 400 };

  // Reset any account whose daily counter is from a previous day (24h+ old)
  const oneDayMs = 24 * 60 * 60 * 1000;
  const now = new Date();
  for (const acc of accounts) {
    if (now.getTime() - new Date(acc.lastReset).getTime() >= oneDayMs) {
      await prisma.emailAccount.update({ where: { id: acc.id }, data: { sentToday: 0, lastReset: now } });
      acc.sentToday = 0;
      acc.lastReset = now;
    }
  }

  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'running', startedAt: campaign.startedAt || new Date() } });

  // VIP first: higher `priority` recipients get queued (and therefore sent) before everyone else
  const recipients = campaign.recipients.filter(r => r.status === 'pending').sort((a, b) => b.priority - a.priority);
  const remaining = new Map(accounts.map(a => [a.id, a.dailyLimit - a.sentToday]));
  let queued = 0;
  let skippedNoCapacity = 0;

  for (const rec of recipients) {
    const eligible = accounts.filter(a => (remaining.get(a.id) || 0) > 0);
    if (!eligible.length) { skippedNoCapacity++; continue; }
    const account = eligible.reduce((best, a) => (remaining.get(a.id)! > remaining.get(best.id)! ? a : best));

    const config = JSON.parse(decrypt(account.config));
    const html = mergeTemplate(campaign.htmlContent, rec);
    const text = mergeTemplate(campaign.textContent, rec);

    await addEmailToQueue({
      providerType: account.providerType, config, to: rec.email, subject: campaign.subject,
      html, text, fromName: campaign.senderName,
      campaignId: campaign.id, recipientId: rec.id, accountId: account.id
    });
    remaining.set(account.id, remaining.get(account.id)! - 1);
    queued++;
  }
  return { success: true, queued, skippedNoCapacity, status: 200 };
}

app.post('/api/campaigns/:id/start', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const result = await startCampaign(req.userId!, req.params.id);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ...result, note: result.skippedNoCapacity ? 'بعض المستلمين لم يُصفّوا بسبب وصول الحد اليومي لكل حساباتك — أعد تشغيل الحملة غدًا لإكمالهم' : undefined });
});

// ---- Scheduling: campaigns created with a future scheduleAt sit as status "scheduled"
// until this loop notices their time has come and starts them automatically. ----
setInterval(async () => {
  try {
    const due = await prisma.campaign.findMany({ where: { status: 'scheduled', scheduledAt: { lte: new Date() } } });
    for (const c of due) await startCampaign(c.userId, c.id);
  } catch (err) { console.error('Scheduler tick failed:', err); }
}, 60 * 1000);

app.post('/api/campaigns/:id/pause', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'paused' } });
  res.json({ success: true });
});

app.get('/api/campaigns/:id/stats', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const c = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!c) return res.status(404).json({ error: 'Not found' });
  const rate = (n: number) => (c.sentCount ? Math.round((n / c.sentCount) * 1000) / 10 : 0);
  res.json({
    total: c.totalEmails, sent: c.sentCount, opened: c.openCount, clicked: c.clickCount, bounced: c.bounceCount, status: c.status,
    openRate: rate(c.openCount), clickRate: rate(c.clickCount), bounceRate: rate(c.bounceCount),
  });
});

// ---- CSV export of a campaign's full recipient report ----
app.get('/api/campaigns/:id/export', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId! }, include: { recipients: true } });
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  const rows = [['email', 'status', 'tag', 'sentAt', 'openedAt', 'clickedAt', 'errorMsg']];
  for (const r of campaign.recipients) {
    rows.push([r.email, r.status, r.tag || '', r.sentAt?.toISOString() || '', r.openedAt?.toISOString() || '', r.clickedAt?.toISOString() || '', (r.errorMsg || '').replace(/[\r\n,]/g, ' ')]);
  }
  const csv = rows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${campaign.name.replace(/[^a-zA-Z0-9-_]/g, '_')}-report.csv"`);
  res.send('\uFEFF' + csv); // BOM so Excel opens Arabic text correctly
});

// ---- Test send: fires the campaign content at one address (e.g. your own) without
// touching campaign counters or recipient rows — for a real "how does this look" check. ----
app.post('/api/campaigns/:id/test-send', requireUnlock, attachOwner, async (req: AuthedRequest, res) => {
  const { to } = req.body;
  if (!to || !isValidEmail(to)) return res.status(400).json({ error: 'صيغة الإيميل غير صحيحة' });
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  const account = await prisma.emailAccount.findFirst({ where: { userId: req.userId!, status: 'active' } });
  if (!account) return res.status(400).json({ error: 'No active email accounts found' });

  const config = JSON.parse(decrypt(account.config));
  const html = mergeTemplate(campaign.htmlContent, { email: to, firstName: 'صديقي', lastName: null, company: null, customFields: null }) + '<p style="color:#999;font-size:12px">— هذه رسالة اختبار، لن تُحتسب ضمن إحصائيات الحملة</p>';
  const text = mergeTemplate(campaign.textContent, { email: to, firstName: 'صديقي', lastName: null, company: null, customFields: null });

  await addEmailToQueue({
    providerType: account.providerType, config, to, subject: '[اختبار] ' + campaign.subject,
    html, text, fromName: campaign.senderName,
    campaignId: null, recipientId: null, accountId: null, // no counters touched
  });
  res.json({ success: true });
});

// ---- Basic heuristic spam-score check (NOT a substitute for real inbox testing —
// just catches the most common obvious red flags before you send to a real list) ----
app.post('/api/spam-check', requireUnlock, attachOwner, (req: AuthedRequest, res) => {
  const { subject = '', htmlContent = '' } = req.body;
  const issues: string[] = [];
  let score = 0;

  const spamWords = ['مجاني تماما', 'اربح الآن', 'اضغط هنا فورا', 'free money', 'act now', 'click here now', 'winner', 'congratulations you', 'viagra', 'casino'];
  const lowerSubject = subject.toLowerCase();
  const lowerHtml = htmlContent.toLowerCase();
  for (const w of spamWords) {
    if (lowerSubject.includes(w) || lowerHtml.includes(w)) { issues.push(`عبارة مثيرة للشك: "${w}"`); score += 15; }
  }

  const capsRatio = subject.length ? (subject.replace(/[^A-Z]/g, '').length / subject.length) : 0;
  if (capsRatio > 0.5 && subject.length > 6) { issues.push('العنوان أغلبه أحرف كابيتال'); score += 15; }

  const exclaims = (subject.match(/!/g) || []).length;
  if (exclaims >= 2) { issues.push('علامات تعجب كثيرة بالعنوان'); score += 10; }

  const linkCount = (htmlContent.match(/href=/g) || []).length;
  const textLength = htmlContent.replace(/<[^>]+>/g, '').length;
  if (linkCount > 5 && textLength < 200) { issues.push('روابط كثيرة نسبة لقلة النص — شكل شائع للسبام'); score += 20; }

  if (!htmlContent.includes('unsubscribe') && !htmlContent.includes('إلغاء الاشتراك')) {
    issues.push('ملاحظة: رابط إلغاء الاشتراك يُضاف تلقائيًا عند الإرسال الفعلي، فلا داعي للقلق هنا');
  }

  res.json({ score: Math.min(score, 100), issues, level: score >= 50 ? 'مرتفع' : score >= 20 ? 'متوسط' : 'منخفض' });
});

// ---- Tracking ----
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64');

app.get('/t/open/:campaignId/:recipientId', async (req, res) => {
  const { campaignId, recipientId } = req.params;
  try {
    const rec = await prisma.recipient.findUnique({ where: { id: recipientId } });
    if (rec && rec.campaignId === campaignId && !rec.openedAt) {
      await prisma.recipient.update({ where: { id: recipientId }, data: { openedAt: new Date(), status: 'opened' } });
      await prisma.campaign.update({ where: { id: campaignId }, data: { openCount: { increment: 1 } } });
    }
  } catch {}
  res.set('Content-Type', 'image/gif').send(PIXEL);
});

app.get('/t/click/:campaignId/:recipientId', async (req, res) => {
  const { campaignId, recipientId } = req.params;
  const rawTarget = (req.query.url as string) || '/';
  // Prevent open-redirect abuse: only ever redirect to a well-formed http(s) URL.
  let target = '/';
  try {
    const parsed = new URL(rawTarget);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') target = parsed.toString();
  } catch { /* not a valid absolute URL — fall back to '/' */ }
  try {
    const rec = await prisma.recipient.findUnique({ where: { id: recipientId } });
    if (rec && rec.campaignId === campaignId) {
      if (!rec.clickedAt) await prisma.campaign.update({ where: { id: campaignId }, data: { clickCount: { increment: 1 } } });
      await prisma.recipient.update({ where: { id: recipientId }, data: { clickedAt: new Date(), status: 'clicked' } });
    }
  } catch {}
  res.redirect(target);
});

// ---- Unsubscribe ----
app.get('/unsubscribe/:campaignId/:recipientId', async (req, res) => {
  const { campaignId, recipientId } = req.params;
  const rec = await prisma.recipient.findUnique({ where: { id: recipientId } });
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!rec || !campaign || rec.campaignId !== campaignId) return res.status(404).send('<h1>Link not found</h1>');

  await prisma.suppression.upsert({
    where: { userId_email: { userId: campaign.userId, email: rec.email } },
    update: {}, create: { userId: campaign.userId, email: rec.email, reason: 'user_unsubscribed' }
  });
  await prisma.recipient.update({ where: { id: recipientId }, data: { status: 'unsubscribed' } });
  res.send(`<html dir="rtl" lang="ar"><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>✅ تم إلغاء اشتراكك بنجاح</h2><p>لن تصلك رسائل أخرى من هذه القائمة.</p></body></html>`);
});

// ---- Health check for Railway/uptime monitors ----
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'db_unreachable' });
  }
});

// This is a private single-user admin tool, not a public site — tell search engines to skip it.
app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /'));

const server = ensureOwnerSeeded().then(() => {
  return app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT} (docs at /api-docs, no login required)`));
});

// Graceful shutdown: let in-flight requests and queue jobs finish before the process exits
// (Railway sends SIGTERM on redeploy/restart — without this, mid-send emails could be cut off)
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully...`);
  (await server).close(() => console.log('HTTP server closed'));
  await prisma.$disconnect();
  setTimeout(() => process.exit(0), 5000); // hard-exit safety net if something hangs
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
