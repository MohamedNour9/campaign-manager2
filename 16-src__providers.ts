import nodemailer from 'nodemailer';
import axios from 'axios';

const HTTP_TIMEOUT_MS = 15000;

export interface EmailProvider {
  send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string): Promise<void>;
  verify(): Promise<{ ok: boolean; message: string }>;
}

// Strips CR/LF from any value that ends up in an email header (subject, sender name).
// Without this, a subject or sender name containing a newline could inject extra SMTP
// headers (e.g. a hidden Bcc) — classic email header injection.
export function sanitizeHeaderValue(value: string): string {
  return (value || '').replace(/[\r\n]+/g, ' ').slice(0, 998);
}

// ---- SMTP (Gmail, Outlook, or any generic SMTP server) ----
export class SmtpProvider implements EmailProvider {
  constructor(private config: any) {}
  private transporter() {
    return nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.username, pass: this.config.password },
      connectionTimeout: HTTP_TIMEOUT_MS,
      socketTimeout: HTTP_TIMEOUT_MS,
    });
  }
  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string) {
    await this.transporter().sendMail({
      from: `"${fromName}" <${this.config.fromEmail}>`, to, subject, html, text,
      headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    });
  }
  async verify() {
    try { await this.transporter().verify(); return { ok: true, message: 'الاتصال بخادم SMTP ناجح' }; }
    catch (err) { return { ok: false, message: describeProviderError(err) }; }
  }
}

// ---- Brevo (transactional email API) ----
export class BrevoProvider implements EmailProvider {
  constructor(private config: any) {}
  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string) {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: fromName, email: this.config.fromEmail },
      to: [{ email: to }],
      subject, htmlContent: html, textContent: text,
      headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    }, { headers: { 'api-key': this.config.apiKey, 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT_MS });
  }
  async verify() {
    try {
      await axios.get('https://api.brevo.com/v3/account', { headers: { 'api-key': this.config.apiKey }, timeout: HTTP_TIMEOUT_MS });
      return { ok: true, message: 'مفتاح Brevo صالح' };
    } catch (err) { return { ok: false, message: describeProviderError(err) }; }
  }
}

// ---- Amazon SES (via SES SMTP interface — no AWS SDK needed) ----
// config: { region, smtpUsername, smtpPassword, fromEmail }
export class SesProvider implements EmailProvider {
  constructor(private config: any) {}
  private transporter() {
    return nodemailer.createTransport({
      host: `email-smtp.${this.config.region}.amazonaws.com`,
      port: 587,
      secure: false,
      auth: { user: this.config.smtpUsername, pass: this.config.smtpPassword },
      connectionTimeout: HTTP_TIMEOUT_MS,
      socketTimeout: HTTP_TIMEOUT_MS,
    });
  }
  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string) {
    await this.transporter().sendMail({
      from: `"${fromName}" <${this.config.fromEmail}>`, to, subject, html, text,
      headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    });
  }
  async verify() {
    try { await this.transporter().verify(); return { ok: true, message: 'الاتصال بـ SES SMTP ناجح' }; }
    catch (err) { return { ok: false, message: describeProviderError(err) }; }
  }
}

// ---- Mailgun (HTTP API) ----
// config: { apiKey, domain, fromEmail }
export class MailgunProvider implements EmailProvider {
  constructor(private config: any) {}
  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string) {
    const params = new URLSearchParams();
    params.append('from', `${fromName} <${this.config.fromEmail}>`);
    params.append('to', to);
    params.append('subject', subject);
    params.append('html', html);
    params.append('text', text);
    if (unsubscribeUrl) {
      params.append('h:List-Unsubscribe', `<${unsubscribeUrl}>`);
      params.append('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
    }
    await axios.post(`https://api.mailgun.net/v3/${this.config.domain}/messages`, params, {
      auth: { username: 'api', password: this.config.apiKey }, timeout: HTTP_TIMEOUT_MS,
    });
  }
  async verify() {
    try {
      await axios.get(`https://api.mailgun.net/v3/domains/${this.config.domain}`, { auth: { username: 'api', password: this.config.apiKey }, timeout: HTTP_TIMEOUT_MS });
      return { ok: true, message: 'نطاق ومفتاح Mailgun صالحين' };
    } catch (err) { return { ok: false, message: describeProviderError(err) }; }
  }
}

// ---- SendGrid (HTTP API v3) ----
// config: { apiKey, fromEmail }
export class SendgridProvider implements EmailProvider {
  constructor(private config: any) {}
  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string) {
    await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: this.config.fromEmail, name: fromName },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
      headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    }, { headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT_MS });
  }
  async verify() {
    try {
      await axios.get('https://api.sendgrid.com/v3/user/account', { headers: { Authorization: `Bearer ${this.config.apiKey}` }, timeout: HTTP_TIMEOUT_MS });
      return { ok: true, message: 'مفتاح SendGrid صالح' };
    } catch (err) { return { ok: false, message: describeProviderError(err) }; }
  }
}

// ---- Resend (HTTP API) ----
// config: { apiKey, fromEmail }
export class ResendProvider implements EmailProvider {
  constructor(private config: any) {}
  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string) {
    await axios.post('https://api.resend.com/emails', {
      from: `${fromName} <${this.config.fromEmail}>`,
      to: [to], subject, html, text,
      headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
    }, { headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT_MS });
  }
  async verify() {
    try {
      await axios.get('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${this.config.apiKey}` }, timeout: HTTP_TIMEOUT_MS });
      return { ok: true, message: 'مفتاح Resend صالح' };
    } catch (err) { return { ok: false, message: describeProviderError(err) }; }
  }
}

export function getProvider(type: string, config: any): EmailProvider {
  switch (type) {
    case 'smtp': return new SmtpProvider(config);
    case 'brevo': return new BrevoProvider(config);
    case 'ses': return new SesProvider(config);
    case 'mailgun': return new MailgunProvider(config);
    case 'sendgrid': return new SendgridProvider(config);
    case 'resend': return new ResendProvider(config);
    default: throw new Error(`Unsupported provider: ${type}`);
  }
}

// Normalizes wildly different error shapes (axios vs nodemailer vs API JSON bodies)
// into one readable string for SendingLog / Recipient.errorMsg.
export function describeProviderError(err: any): string {
  if (err?.response?.data) {
    const d = err.response.data;
    return typeof d === 'string' ? d : (d.message || d.Message || JSON.stringify(d)).slice(0, 500);
  }
  return (err?.message || String(err)).slice(0, 500);
}
