import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';
import swaggerUi from 'swagger-ui-express';
import path from 'path';
import { ensureOwnerSeeded, AuthedRequest, attachOwner, requireUnlock, checkUnlockPassword } from './auth';
import { encrypt, decrypt } from './crypto';
import { addEmailToQueue, emailQueue, emailWorker } from './queue';
import { parseRecipientFile, isValidEmail, DISPOSABLE_DOMAINS, mergeTemplate } from './upload';
import { getProvider, describeProviderError, sanitizeHeaderValue } from './providers';
import { swaggerSpec } from './swagger';

const prisma = new PrismaClient();
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'طلبات كثيرة جداً — حاول بعد شوية' },
});
app.use(globalLimiter);

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// API docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ---------------------------------------------------------------------------
// Unlock / Auth routes
// ---------------------------------------------------------------------------

/** POST /api/unlock – enter the shared APP_PASSWORD to get a session token */
app.post('/api/unlock', (req: Request, res: Response) => {
  const { password } = req.body;
  const token = checkUnlockPassword(password || '');
  if (!token) return res.status(401).json({ error: 'كلمة المرور خطأ' });
  res.json({ token, open: token === 'unlocked' });
});

/** POST /api/auth/register – single-owner stub; not a real multi-user register */
app.post('/api/auth/register', async (req: Request, res: Response) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل' });
  const user = await prisma.user.create({ data: { email, password, name } });
  res.status(201).json({ id: user.id, email: user.email, name: user.name });
});

/** POST /api/auth/login */
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.password !== password) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  res.json({ id: user.id, email: user.email, name: user.name });
});

// ---------------------------------------------------------------------------
// Protected routes (require unlock + owner attachment)
// ---------------------------------------------------------------------------
app.use('/api', requireUnlock, attachOwner);

// Allow token from query param for file downloads (CSV export via window.open)
app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
  const qt = req.query.token as string | undefined;
  if (qt && !req.headers.authorization) req.headers.authorization = 'Bearer ' + qt;
  next();
});

// ========================== ACCOUNTS ==========================

/** GET /api/accounts – list all sending accounts */
app.get('/api/accounts', async (req: AuthedRequest, res: Response) => {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, providerType: true, name: true, dailyLimit: true,
      perHourLimit: true, perMinuteLimit: true, status: true,
      warmupEnabled: true, warmupStartAt: true,
      sentToday: true, successCount: true, failureCount: true,
      lastUsedAt: true, createdAt: true,
    },
  });
  res.json(accounts);
});

/** POST /api/accounts – add a sending account */
app.post('/api/accounts', async (req: AuthedRequest, res: Response) => {
  const { providerType, name, config } = req.body;
  if (!providerType || !config) return res.status(400).json({ error: 'نوع المزود والإعدادات مطلوبان' });

  // Validate by attempting to create the provider
  try {
    getProvider(providerType, config);
  } catch {
    return res.status(400).json({ error: 'إعدادات غير صالحة للمزود المختار' });
  }

  const encryptedConfig = encrypt(JSON.stringify(config));
  const account = await prisma.emailAccount.create({
    data: {
      userId: req.userId!,
      providerType,
      name: name || providerType,
      config: encryptedConfig,
    },
  });
  res.status(201).json({ id: account.id, providerType, name: account.name, status: account.status });
});

/** PUT /api/accounts/:id – update account */
app.put('/api/accounts/:id', async (req: AuthedRequest, res: Response) => {
  const { id } = req.params;
  const { name, config, dailyLimit, perHourLimit, perMinuteLimit, status, warmupEnabled } = req.body;

  const account = await prisma.emailAccount.findFirst({ where: { id, userId: req.userId } });
  if (!account) return res.status(404).json({ error: 'الحساب غير موجود' });

  const data: any = {};
  if (name !== undefined) data.name = name;
  if (dailyLimit !== undefined) data.dailyLimit = dailyLimit;
  if (perHourLimit !== undefined) data.perHourLimit = perHourLimit;
  if (perMinuteLimit !== undefined) data.perMinuteLimit = perMinuteLimit;
  if (status !== undefined) data.status = status;
  if (warmupEnabled !== undefined) data.warmupEnabled = warmupEnabled;
  if (config) data.config = encrypt(JSON.stringify(config));

  const updated = await prisma.emailAccount.update({ where: { id }, data });
  res.json({ id: updated.id, providerType: updated.providerType, name: updated.name, status: updated.status });
});

/** DELETE /api/accounts/:id */
app.delete('/api/accounts/:id', async (req: AuthedRequest, res: Response) => {
  const { id } = req.params;
  const account = await prisma.emailAccount.findFirst({ where: { id, userId: req.userId } });
  if (!account) return res.status(404).json({ error: 'الحساب غير موجود' });
  await prisma.emailAccount.delete({ where: { id } });
  res.json({ success: true });
});

/** POST /api/accounts/test – test an account config without saving */
app.post('/api/accounts/test', async (req: AuthedRequest, res: Response) => {
  const { providerType, config, testEmail } = req.body;
  if (!providerType || !config || !testEmail) return res.status(400).json({ error: 'البيانات غير كاملة' });

  try {
    const provider = getProvider(providerType, config);
    await provider.send(testEmail, '🧪 اختبار إرسال', '<h1>تم بنجاح ✓</h1><p>إعدادات الحساب سليمة.</p>', 'تم بنجاح', 'اختبار');
    res.json({ success: true, message: 'تم الإرسال التجريبي بنجاح ✓' });
  } catch (err) {
    res.status(400).json({ success: false, error: describeProviderError(err) });
  }
});

// ========================== BLOCKED DOMAINS ==========================

/** GET /api/blocked-domains */
app.get('/api/blocked-domains', async (req: AuthedRequest, res: Response) => {
  const domains = await prisma.blockedDomain.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' } });
  res.json(domains);
});

/** POST /api/blocked-domains */
app.post('/api/blocked-domains', async (req: AuthedRequest, res: Response) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'النطاق مطلوب' });
  const existing = await prisma.blockedDomain.findFirst({ where: { userId: req.userId, domain: domain.toLowerCase().trim() } });
  if (existing) return res.status(409).json({ error: 'النطاق موجود بالفعل' });
  const blocked = await prisma.blockedDomain.create({ data: { userId: req.userId!, domain: domain.toLowerCase().trim() } });
  res.status(201).json(blocked);
});

/** DELETE /api/blocked-domains/:id */
app.delete('/api/blocked-domains/:id', async (req: AuthedRequest, res: Response) => {
  const { id } = req.params;
  await prisma.blockedDomain.delete({ where: { id } }).catch(() => {});
  res.json({ success: true });
});

// ========================== SUPPRESSIONS ==========================

/** GET /api/suppressions */
app.get('/api/suppressions', async (req: AuthedRequest, res: Response) => {
  const suppressions = await prisma.suppression.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json(suppressions);
});

/** DELETE /api/suppressions/:id */
app.delete('/api/suppressions/:id', async (req: AuthedRequest, res: Response) => {
  await prisma.suppression.delete({ where: { id: req.params.id } }).catch(() => {});
  res.json({ success: true });
});

// ========================== UPLOAD ==========================

/** POST /api/upload – upload a recipient list CSV/TXT and return parsed recipients */
app.post('/api/upload', upload.single('file'), async (req: AuthedRequest, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'الملف مطلوب' });
  const text = req.file.buffer.toString('utf-8');
  const parsed = parseRecipientFile(text);
  const valid = parsed.filter(r => isValidEmail(r.email) && !DISPOSABLE_DOMAINS.has(r.email.split('@')[1]));
  const invalid = parsed.length - valid.length;
  res.json({ total: parsed.length, valid: valid.length, invalid, recipients: valid });
});

// ========================== CAMPAIGNS ==========================

/** GET /api/campaigns */
app.get('/api/campaigns', async (req: AuthedRequest, res: Response) => {
  const campaigns = await prisma.campaign.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { recipients: true } } },
  });
  res.json(campaigns);
});

/** GET /api/campaigns/:id */
app.get('/api/campaigns/:id', async (req: AuthedRequest, res: Response) => {
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.id, userId: req.userId },
    include: { _count: { select: { recipients: true } } },
  });
  if (!campaign) return res.status(404).json({ error: 'الحملة غير موجودة' });
  res.json(campaign);
});

/** POST /api/campaigns – create a campaign */
app.post('/api/campaigns', async (req: AuthedRequest, res: Response) => {
  const { name, subject, senderName, htmlContent, textContent, tag, scheduledAt } = req.body;
  if (!name || !subject) return res.status(400).json({ error: 'الاسم والموضوع مطلوبان' });

  const campaign = await prisma.campaign.create({
    data: {
      userId: req.userId!,
      name,
      subject,
      senderName: senderName || '',
      htmlContent: htmlContent || '',
      textContent: textContent || '',
      tag: tag || null,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    },
  });
  res.status(201).json(campaign);
});

/** PUT /api/campaigns/:id – update campaign */
app.put('/api/campaigns/:id', async (req: AuthedRequest, res: Response) => {
  const { id } = req.params;
  const { name, subject, senderName, htmlContent, textContent, tag } = req.body;

  const campaign = await prisma.campaign.findFirst({ where: { id, userId: req.userId } });
  if (!campaign) return res.status(404).json({ error: 'الحملة غير موجودة' });

  const data: any = {};
  if (name !== undefined) data.name = name;
  if (subject !== undefined) data.subject = subject;
  if (senderName !== undefined) data.senderName = senderName;
  if (htmlContent !== undefined) data.htmlContent = htmlContent;
  if (textContent !== undefined) data.textContent = textContent;
  if (tag !== undefined) data.tag = tag;

  const updated = await prisma.campaign.update({ where: { id }, data });
  res.json(updated);
});

/** DELETE /api/campaigns/:id */
app.delete('/api/campaigns/:id', async (req: AuthedRequest, res: Response) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!campaign) return res.status(404).json({ error: 'الحملة غير موجودة' });
  await prisma.campaign.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

/** POST /api/campaigns/:id/recipients – add recipients to a campaign */
app.post('/api/campaigns/:id/recipients', async (req: AuthedRequest, res: Response) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!campaign) return res.status(404).json({ error: 'الحملة غير موجودة' });

  const { recipients } = req.body;
  if (!Array.isArray(recipients) || !recipients.length) return res.status(400).json({ error: 'المستلمون مطلوبون' });

  // Filter valid emails
  const validRecipients = recipients.filter((r: any) => isValidEmail(r.email));

  // Batch create recipients (SQLite doesn't support skipDuplicates, so we filter manually)
  const existingEmails = new Set(
    (await prisma.recipient.findMany({
      where: { campaignId: req.params.id, email: { in: validRecipients.map((r: any) => r.email.toLowerCase()) } },
      select: { email: true },
    })).map(r => r.email)
  );
  const newRecipients = validRecipients.filter((r: any) => !existingEmails.has(r.email.toLowerCase()));

  // SQLite doesn't support createMany — create each recipient individually
  let added = 0;
  for (const r of newRecipients) {
    await prisma.recipient.create({
      data: {
        campaignId: req.params.id,
        email: r.email.toLowerCase(),
        firstName: r.firstName || null,
        lastName: r.lastName || null,
        company: r.company || null,
        tag: r.tag || null,
        priority: r.priority || 0,
        customFields: r.customFields ? JSON.stringify(r.customFields) : null,
      },
    });
    added++;
  }

  // Update campaign total
  const total = await prisma.recipient.count({ where: { campaignId: req.params.id } });
  await prisma.campaign.update({ where: { id: req.params.id }, data: { totalCount: total } });

  res.json({ added, total });
});

/** GET /api/campaigns/:id/recipients – list recipients of a campaign */
app.get('/api/campaigns/:id/recipients', async (req: AuthedRequest, res: Response) => {
  const recipients = await prisma.recipient.findMany({
    where: { campaignId: req.params.id },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    take: 5000,
  });
  res.json(recipients);
});

/** POST /api/campaigns/:id/start – start sending a campaign */
app.post('/api/campaigns/:id/start', async (req: AuthedRequest, res: Response) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!campaign) return res.status(404).json({ error: 'الحملة غير موجودة' });
  if (campaign.status === 'sending') return res.status(400).json({ error: 'الحملة قيد الإرسال بالفعل' });

  // Get active accounts for this user
  const accounts = await prisma.emailAccount.findMany({
    where: { userId: req.userId, status: 'active' },
    orderBy: { successCount: 'desc' },
  });
  if (!accounts.length) return res.status(400).json({ error: 'لا يوجد حسابات إرسال نشطة — أضف حساب أولاً' });

  // Get pending recipients, filtered by tag if set
  const where: any = { campaignId: campaign.id, status: 'pending' };
  if (campaign.tag) where.tag = campaign.tag;

  const recipients = await prisma.recipient.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });

  if (!recipients.length) return res.status(400).json({ error: 'لا يوجد مستلمون جاهزون للإرسال' });

  // Update campaign status
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: 'sending', startedAt: new Date(), totalCount: recipients.length },
  });

  // Queue each recipient
  let queued = 0;
  for (const recipient of recipients) {
    const accountIndex = queued % accounts.length;
    const account = accounts[accountIndex];

    const recipientHtml = mergeTemplate(campaign.htmlContent, recipient);
    const recipientText = mergeTemplate(campaign.textContent, recipient);
    const subject = mergeTemplate(campaign.subject, recipient);

    await addEmailToQueue({
      providerType: account.providerType,
      config: JSON.parse(decrypt(account.config)),
      to: recipient.email,
      subject: sanitizeHeaderValue(subject),
      html: recipientHtml,
      text: recipientText,
      fromName: sanitizeHeaderValue(campaign.senderName),
      campaignId: campaign.id,
      recipientId: recipient.id,
      accountId: account.id,
    });

    await prisma.recipient.update({ where: { id: recipient.id }, data: { status: 'queued' } });
    queued++;
  }

  res.json({ success: true, queued, total: recipients.length });
});

/** POST /api/campaigns/:id/pause – pause sending */
app.post('/api/campaigns/:id/pause', async (req: AuthedRequest, res: Response) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!campaign) return res.status(404).json({ error: 'الحملة غير موجودة' });
  await prisma.campaign.update({ where: { id: req.params.id }, data: { status: 'paused' } });
  res.json({ success: true, status: 'paused' });
});

/** GET /api/campaigns/:id/stats – get campaign statistics */
app.get('/api/campaigns/:id/stats', async (req: AuthedRequest, res: Response) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!campaign) return res.status(404).json({ error: 'الحملة غير موجودة' });

  const statusCounts = await prisma.recipient.groupBy({
    by: ['status'],
    where: { campaignId: campaign.id },
    _count: true,
  });

  const stats: Record<string, number> = {};
  for (const s of statusCounts) stats[s.status] = s._count;

  res.json({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    total: campaign.totalCount,
    sent: campaign.sentCount,
    opens: campaign.openCount,
    clicks: campaign.clickCount,
    failed: campaign.failedCount,
    statusBreakdown: stats,
  });
});

/** POST /api/campaigns/:id/test – send a test email */
app.post('/api/campaigns/:id/test', async (req: AuthedRequest, res: Response) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!campaign) return res.status(404).json({ error: 'الحملة غير موجودة' });

  const { testEmail, accountId } = req.body;
  if (!testEmail) return res.status(400).json({ error: 'البريد الإلكتروني للاختبار مطلوب' });

  const account = await prisma.emailAccount.findFirst({ where: { id: accountId || undefined, userId: req.userId, status: 'active' } });
  if (!account) return res.status(400).json({ error: 'حساب الإرسال غير موجود أو غير نشط' });

  const config = JSON.parse(decrypt(account.config));
  const provider = getProvider(account.providerType, config);

  try {
    await provider.send(
      testEmail,
      sanitizeHeaderValue(`[اختبار] ${campaign.subject}`),
      campaign.htmlContent,
      campaign.textContent,
      sanitizeHeaderValue(campaign.senderName),
    );
    res.json({ success: true, message: 'تم إرسال البريد التجريبي ✓' });
  } catch (err) {
    res.status(400).json({ success: false, error: describeProviderError(err) });
  }
});

/** GET /api/campaigns/:id/export – export campaign recipients as CSV */
app.get('/api/campaigns/:id/export', async (req: AuthedRequest, res: Response) => {
  const recipients = await prisma.recipient.findMany({
    where: { campaignId: req.params.id },
    orderBy: [{ priority: 'desc' }, { email: 'asc' }],
  });

  const header = 'email,firstName,lastName,company,tag,priority,status,errorMsg,sentAt';
  const rows = recipients.map(r =>
    `"${r.email}","${r.firstName || ''}","${r.lastName || ''}","${r.company || ''}","${r.tag || ''}",${r.priority},"${r.status}","${r.errorMsg || ''}","${r.sentAt ? r.sentAt.toISOString() : ''}"`
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="recipients.csv"');
  res.send('\uFEFF' + header + '\n' + rows.join('\n')); // BOM for Excel Arabic support
});

// ========================== TRACKING ==========================

/** GET /t/open/:campaignId/:recipientId – tracking pixel (1×1 GIF) */
app.get('/t/open/:campaignId/:recipientId', async (req: Request, res: Response) => {
  await prisma.recipient.updateMany({
    where: { id: req.params.recipientId, campaignId: req.params.campaignId, status: 'sent' },
    data: { status: 'opened', openedAt: new Date() },
  });
  await prisma.campaign.updateMany({
    where: { id: req.params.campaignId },
    data: { openCount: { increment: 1 } },
  });
  await prisma.trackingEvent.create({
    data: {
      campaignId: req.params.campaignId,
      recipientId: req.params.recipientId,
      type: 'open',
      userAgent: req.headers['user-agent'] || null,
      ip: req.ip || null,
    },
  }).catch(() => {});

  // 1×1 transparent GIF
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': gif.length, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  res.end(gif);
});

/** GET /t/click/:campaignId/:recipientId – track click and redirect */
app.get('/t/click/:campaignId/:recipientId', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send('Missing URL');

  await prisma.recipient.updateMany({
    where: { id: req.params.recipientId, campaignId: req.params.campaignId },
    data: { status: 'clicked', clickedAt: new Date() },
  });
  await prisma.campaign.updateMany({
    where: { id: req.params.campaignId },
    data: { clickCount: { increment: 1 } },
  });
  await prisma.trackingEvent.create({
    data: {
      campaignId: req.params.campaignId,
      recipientId: req.params.recipientId,
      type: 'click',
      url,
      userAgent: req.headers['user-agent'] || null,
      ip: req.ip || null,
    },
  }).catch(() => {});

  res.redirect(302, url);
});

/** GET /unsubscribe/:campaignId/:recipientId – one-click unsubscribe */
app.get('/unsubscribe/:campaignId/:recipientId', async (req: Request, res: Response) => {
  const { campaignId, recipientId } = req.params;

  const recipient = await prisma.recipient.findUnique({ where: { id: recipientId } });
  if (recipient) {
    await prisma.recipient.update({ where: { id: recipientId }, data: { status: 'unsubscribed' } });

    // Add to suppression list
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (campaign) {
      await prisma.suppression.create({
        data: { userId: campaign.userId, email: recipient.email, reason: 'unsubscribed' },
      }).catch(() => {});
    }
  }

  res.send(`
    <!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>تم إلغاء الاشتراك</title>
    <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
    .card{background:white;padding:40px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.1);text-align:center}
    h1{color:#22c55e;margin-bottom:8px}p{color:#666}</style>
    <body><div class="card"><h1>✓ تم إلغاء الاشتراك</h1><p>لن تستقبل رسائل من هذه القائمة بعد الآن.</p></div></body></html>
  `);
});

// ========================== SCHEDULER ==========================

// Every 60 seconds, check for scheduled campaigns that are due
setInterval(async () => {
  try {
    const due = await prisma.campaign.findMany({
      where: {
        status: 'draft',
        scheduledAt: { lte: new Date() },
      },
    });

    for (const campaign of due) {
      // Trigger the start endpoint logic manually
      const accounts = await prisma.emailAccount.findMany({
        where: { userId: campaign.userId, status: 'active' },
        orderBy: { successCount: 'desc' },
      });
      if (!accounts.length) continue;

      const whereRecipients: any = { campaignId: campaign.id, status: 'pending' };
      if (campaign.tag) whereRecipients.tag = campaign.tag;

      const recipients = await prisma.recipient.findMany({
        where: whereRecipients,
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      });
      if (!recipients.length) continue;

      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'sending', startedAt: new Date(), totalCount: recipients.length },
      });

      let queued = 0;
      for (const recipient of recipients) {
        const accountIndex = queued % accounts.length;
        const account = accounts[accountIndex];

        const recipientHtml = mergeTemplate(campaign.htmlContent, recipient);
        const recipientText = mergeTemplate(campaign.textContent, recipient);
        const subject = mergeTemplate(campaign.subject, recipient);

        await addEmailToQueue({
          providerType: account.providerType,
          config: JSON.parse(decrypt(account.config)),
          to: recipient.email,
          subject: sanitizeHeaderValue(subject),
          html: recipientHtml,
          text: recipientText,
          fromName: sanitizeHeaderValue(campaign.senderName),
          campaignId: campaign.id,
          recipientId: recipient.id,
          accountId: account.id,
        });

        await prisma.recipient.update({ where: { id: recipient.id }, data: { status: 'queued' } });
        queued++;
      }

      console.log(`⏰ Scheduled campaign "${campaign.name}" started — ${queued} emails queued`);
    }
  } catch (err) {
    console.error('Scheduler error:', err);
  }
}, 60000);

// ========================== DASHBOARD STATS ==========================

/** GET /api/stats – dashboard stats */
app.get('/api/stats', async (req: AuthedRequest, res: Response) => {
  const [accounts, campaigns, totalSent, totalOpens, totalClicks] = await Promise.all([
    prisma.emailAccount.count({ where: { userId: req.userId } }),
    prisma.campaign.count({ where: { userId: req.userId } }),
    prisma.campaign.aggregate({ where: { userId: req.userId }, _sum: { sentCount: true } }),
    prisma.campaign.aggregate({ where: { userId: req.userId }, _sum: { openCount: true } }),
    prisma.campaign.aggregate({ where: { userId: req.userId }, _sum: { clickCount: true } }),
  ]);

  // Recent campaign activity
  const recentCampaigns = await prisma.campaign.findMany({
    where: { userId: req.userId },
    orderBy: { updatedAt: 'desc' },
    take: 5,
    select: { id: true, name: true, status: true, sentCount: true, totalCount: true, updatedAt: true },
  });

  res.json({
    accounts,
    campaigns,
    totalSent: totalSent._sum.sentCount || 0,
    totalOpens: totalOpens._sum.openCount || 0,
    totalClicks: totalClicks._sum.clickCount || 0,
    recentCampaigns,
  });
});

// ========================== SPA FALLBACK ==========================

// All unmatched routes serve the frontend (SPA-style)
app.get('*', (req: Request, res: Response) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/t/')) return res.status(404).json({ error: 'المسار غير موجود' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ========================== START ==========================

const PORT = parseInt(process.env.PORT || '3000');

async function main() {
  await ensureOwnerSeeded();
  console.log('✅ Owner account seeded');

  // Clean up any stuck "sending" campaigns from a previous crash
  const stuckCampaigns = await prisma.campaign.updateMany({
    where: { status: 'sending' },
    data: { status: 'paused' },
  });
  if (stuckCampaigns.count > 0) console.log(`⏸️ Paused ${stuckCampaigns.count} stuck campaign(s)`);

  // Restore pending jobs from DB (survives restarts)
  // Wait a moment for the queue singleton to be ready, then restore
  setImmediate(async () => {
    await emailQueue.restoreJobsFromDb();
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Email Campaign Manager running on http://0.0.0.0:${PORT}`);
    console.log(`📖 API docs: http://0.0.0.0:${PORT}/api-docs`);
  });
}

main().catch((err) => {
  console.error('❌ Failed to start:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await emailWorker.close();
  await emailQueue.close();
  await prisma.$disconnect();
  process.exit(0);
});
