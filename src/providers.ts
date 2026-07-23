import nodemailer from 'nodemailer';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Provider interface – every email provider must implement this contract so the
// queue worker can send through any of them interchangeably.
// ---------------------------------------------------------------------------
export interface EmailProvider {
  send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory – returns the correct provider for a given type + config blob.
// ---------------------------------------------------------------------------
export function getProvider(type: string, config: any): EmailProvider {
  switch (type) {
    case 'smtp':
      return new SmtpProvider(config);
    case 'brevo':
      return new BrevoProvider(config);
    case 'sendgrid':
      return new SendGridProvider(config);
    case 'mailgun':
      return new MailgunProvider(config);
    case 'ses':
      return new SesProvider(config);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Converts a caught error into a human-readable (Arabic-friendly) message. */
export function describeProviderError(err: any): string {
  if (!err) return 'Unknown error';
  if (err.response?.data?.message) return String(err.response.data.message);
  if (err.response?.data?.error) return String(err.response.data.error);
  if (err.message) return String(err.message);
  return String(err);
}

/** Strips characters that mail servers commonly reject in header values. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

// ---- SMTP (Gmail, Outlook, any SMTP server) ----
class SmtpProvider implements EmailProvider {
  private transporter: nodemailer.Transporter;
  private fromEmail: string;
  private fromName: string;

  constructor(config: any) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port || 587,
      secure: config.secure === true || config.port === 465,
      auth: { user: config.username, pass: config.password },
    });
    this.fromEmail = config.fromEmail;
    this.fromName = config.fromName || '';
  }

  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string): Promise<void> {
    const mailOptions: any = {
      from: `"${fromName || this.fromName}" <${this.fromEmail}>`,
      to,
      subject,
      html,
      text,
    };

    // Add List-Unsubscribe header for compliance (Gmail/Yahoo require it)
    if (unsubscribeUrl) {
      mailOptions.headers = {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }

    await this.transporter.sendMail(mailOptions);
  }
}

// ---- Brevo (formerly Sendinblue) HTTP API ----
class BrevoProvider implements EmailProvider {
  private apiKey: string;
  private fromEmail: string;
  private fromName: string;

  constructor(config: any) {
    this.apiKey = config.apiKey;
    this.fromEmail = config.fromEmail;
    this.fromName = config.fromName || '';
  }

  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string): Promise<void> {
    const payload: any = {
      sender: { email: this.fromEmail, name: fromName || this.fromName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    };

    if (unsubscribeUrl) {
      payload.headers = {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
      };
    }

    await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  }
}

// ---- SendGrid HTTP API v3 ----
class SendGridProvider implements EmailProvider {
  private apiKey: string;
  private fromEmail: string;
  private fromName: string;

  constructor(config: any) {
    this.apiKey = config.apiKey;
    this.fromEmail = config.fromEmail;
    this.fromName = config.fromName || '';
  }

  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string): Promise<void> {
    const personalizations: any = {
      to: [{ email: to }],
      subject,
    };

    if (unsubscribeUrl) {
      personalizations.headers = {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }

    const payload = {
      personalizations: [personalizations],
      from: { email: this.fromEmail, name: fromName || this.fromName },
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    };

    await axios.post('https://api.sendgrid.com/v3/mail/send', payload, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }
}

// ---- Mailgun HTTP API ----
class MailgunProvider implements EmailProvider {
  private apiKey: string;
  private domain: string;
  private fromEmail: string;
  private fromName: string;

  constructor(config: any) {
    this.apiKey = config.apiKey;
    this.domain = config.domain;
    this.fromEmail = config.fromEmail;
    this.fromName = config.fromName || '';
  }

  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string): Promise<void> {
    const formData = new URLSearchParams();
    formData.append('from', `"${fromName || this.fromName}" <${this.fromEmail}>`);
    formData.append('to', to);
    formData.append('subject', subject);
    formData.append('html', html);
    formData.append('text', text);

    if (unsubscribeUrl) {
      formData.append('h:List-Unsubscribe', `<${unsubscribeUrl}>`);
      formData.append('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
    }

    const api = this.domain.includes('/') ? this.domain : `https://api.mailgun.net/v3/${this.domain}/messages`;
    await axios.post(api, formData.toString(), {
      auth: { username: 'api', password: this.apiKey },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
}

// ---- Amazon SES (SMTP interface) ----
class SesProvider implements EmailProvider {
  private transporter: nodemailer.Transporter;
  private fromEmail: string;
  private fromName: string;

  constructor(config: any) {
    this.transporter = nodemailer.createTransport({
      host: `email-smtp.${config.region || 'us-east-1'}.amazonaws.com`,
      port: 587,
      secure: false,
      auth: { user: config.smtpUsername, pass: config.smtpPassword },
    });
    this.fromEmail = config.fromEmail;
    this.fromName = config.fromName || '';
  }

  async send(to: string, subject: string, html: string, text: string, fromName: string, unsubscribeUrl?: string): Promise<void> {
    const mailOptions: any = {
      from: `"${fromName || this.fromName}" <${this.fromEmail}>`,
      to,
      subject,
      html,
      text,
    };

    if (unsubscribeUrl) {
      mailOptions.headers = {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }

    await this.transporter.sendMail(mailOptions);
  }
}
