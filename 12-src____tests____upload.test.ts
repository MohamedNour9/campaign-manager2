import { parseRecipientFile, isValidEmail, mergeTemplate } from '../upload';

describe('isValidEmail', () => {
  it('accepts normal addresses', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.example.co')).toBe(true);
  });
  it('rejects malformed addresses', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('missing@domain')).toBe(false);
    expect(isValidEmail('double..dot@example.com')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
  });
  it('rejects overly long addresses', () => {
    const long = 'a'.repeat(250) + '@example.com';
    expect(isValidEmail(long)).toBe(false);
  });
});

describe('parseRecipientFile', () => {
  it('falls back to plain-list extraction when there is no header row', () => {
    const text = 'first@example.com\nsecond@example.com, third@example.com';
    const result = parseRecipientFile(text);
    expect(result.map(r => r.email)).toEqual(['first@example.com', 'second@example.com', 'third@example.com']);
  });

  it('parses a structured CSV with a header row', () => {
    const text = 'email,firstName,tag,priority,plan\nuser@example.com,Sara,vip,5,pro';
    const result = parseRecipientFile(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ email: 'user@example.com', firstName: 'Sara', tag: 'vip', priority: 5 });
    expect(result[0].customFields).toEqual({ plan: 'pro' });
  });

  it('handles quoted commas inside CSV fields', () => {
    const text = 'email,company\nuser@example.com,"Acme, Inc."';
    const result = parseRecipientFile(text);
    expect(result[0].company).toBe('Acme, Inc.');
  });
});

describe('mergeTemplate', () => {
  it('substitutes built-in fields', () => {
    const out = mergeTemplate('Hi {{first_name}} from {{company}}', { email: 'x@y.com', firstName: 'Ali', lastName: null, company: 'Acme', customFields: null });
    expect(out).toBe('Hi Ali from Acme');
  });
  it('falls back to the email prefix when first_name is missing', () => {
    const out = mergeTemplate('Hi {{first_name}}', { email: 'ali@example.com', firstName: null, lastName: null, company: null, customFields: null });
    expect(out).toBe('Hi ali');
  });
  it('substitutes arbitrary custom fields', () => {
    const out = mergeTemplate('Your plan: {{plan}}', { email: 'x@y.com', firstName: null, lastName: null, company: null, customFields: JSON.stringify({ plan: 'pro' }) });
    expect(out).toBe('Your plan: pro');
  });
  it('leaves unknown placeholders untouched', () => {
    const out = mergeTemplate('Hi {{unknown_field}}', { email: 'x@y.com', firstName: null, lastName: null, company: null, customFields: null });
    expect(out).toBe('Hi {{unknown_field}}');
  });
});
