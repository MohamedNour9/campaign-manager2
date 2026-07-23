import { describeProviderError, sanitizeHeaderValue, getProvider } from '../providers';

describe('providers', () => {
  describe('describeProviderError', () => {
    it('returns "Unknown error" for null/undefined', () => {
      expect(describeProviderError(null)).toBe('Unknown error');
      expect(describeProviderError(undefined)).toBe('Unknown error');
    });

    it('returns the response body message if available', () => {
      const err = { response: { data: { message: 'Rate limit exceeded' } } };
      expect(describeProviderError(err)).toBe('Rate limit exceeded');
    });

    it('returns the response body error if message is not available', () => {
      const err = { response: { data: { error: 'Invalid API key' } } };
      expect(describeProviderError(err)).toBe('Invalid API key');
    });

    it('returns the Error message as fallback', () => {
      expect(describeProviderError(new Error('Connection refused'))).toBe('Connection refused');
    });

    it('coerces plain strings', () => {
      expect(describeProviderError('oops')).toBe('oops');
    });
  });

  describe('sanitizeHeaderValue', () => {
    it('removes carriage returns and newlines', () => {
      // Each \r and \n is replaced individually with a space
      expect(sanitizeHeaderValue('hello\r\nworld')).toBe('hello  world');
    });

    it('trims whitespace', () => {
      expect(sanitizeHeaderValue('  padded  ')).toBe('padded');
    });

    it('passes through clean values', () => {
      expect(sanitizeHeaderValue('John Doe')).toBe('John Doe');
    });
  });

  describe('getProvider', () => {
    it('returns an SMTP provider for type "smtp"', () => {
      const provider = getProvider('smtp', { host: 'smtp.example.com', fromEmail: 'a@b.com' });
      expect(provider).toBeDefined();
      expect(typeof provider.send).toBe('function');
    });

    it('returns a Brevo provider for type "brevo"', () => {
      const provider = getProvider('brevo', { apiKey: 'x', fromEmail: 'a@b.com' });
      expect(provider).toBeDefined();
    });

    it('returns a SendGrid provider for type "sendgrid"', () => {
      const provider = getProvider('sendgrid', { apiKey: 'x', fromEmail: 'a@b.com' });
      expect(provider).toBeDefined();
    });

    it('returns a Mailgun provider for type "mailgun"', () => {
      const provider = getProvider('mailgun', { apiKey: 'x', domain: 'mg.example.com', fromEmail: 'a@b.com' });
      expect(provider).toBeDefined();
    });

    it('returns an SES provider for type "ses"', () => {
      const provider = getProvider('ses', { smtpUsername: 'u', smtpPassword: 'p', fromEmail: 'a@b.com' });
      expect(provider).toBeDefined();
    });

    it('throws for unknown provider type', () => {
      expect(() => getProvider('unknown', {})).toThrow('Unknown provider type');
    });
  });
});
