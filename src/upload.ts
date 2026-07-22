// Parses uploaded CSV/TXT recipient files. Supports two modes:
//  1) Plain list — just email addresses anywhere in the text (old behavior, always works).
//  2) Structured CSV with a header row containing "email" — also picks up firstName,
//     lastName, company, tag, priority, plus any other column as a custom merge field.

export interface ParsedRecipient {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  tag?: string;
  priority?: number;
  customFields?: Record<string, string>;
}

const KNOWN_HEADERS = new Set(['email', 'firstname', 'first_name', 'lastname', 'last_name', 'company', 'tag', 'segment', 'priority']);

function splitCsvLine(line: string): string[] {
  // Minimal CSV split that respects double-quoted fields containing commas.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseRecipientFile(text: string): ParsedRecipient[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const headerCols = splitCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ''));
  const hasEmailHeader = headerCols.includes('email');

  if (!hasEmailHeader) {
    // Fallback: plain-list mode, just pull anything email-shaped out of the whole text.
    const regex = /[^\s,;<>"']+@[^\s,;<>"']+/g;
    return (text.match(regex) || []).map(e => ({ email: e.toLowerCase().trim() }));
  }

  const recipients: ParsedRecipient[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (!cols.length || !cols.some(c => c)) continue;
    const row: Record<string, string> = {};
    headerCols.forEach((h, idx) => { row[h] = cols[idx] || ''; });
    if (!row.email) continue;

    const customFields: Record<string, string> = {};
    for (const [key, val] of Object.entries(row)) {
      if (!KNOWN_HEADERS.has(key) && val) customFields[key] = val;
    }

    recipients.push({
      email: row.email.toLowerCase().trim(),
      firstName: row.firstname || row.first_name || undefined,
      lastName: row.lastname || row.last_name || undefined,
      company: row.company || undefined,
      tag: row.tag || row.segment || undefined,
      priority: row.priority ? parseInt(row.priority) || 0 : undefined,
      customFields: Object.keys(customFields).length ? customFields : undefined,
    });
  }
  return recipients;
}

// Stricter validation than a bare regex: rejects consecutive dots, bad edges, overly
// long local-parts — catches common copy-paste corruption in real recipient lists.
export function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;
  const re = /^[a-zA-Z0-9](?:[a-zA-Z0-9._+%-]*[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
  if (!re.test(email)) return false;
  if (email.includes('..')) return false;
  return true;
}

export const DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com', 'yopmail.com']);

// Merges a recipient's fields (firstName/lastName/company/customFields) into template
// text using {{field_name}} syntax — generalizes the old hardcoded {{first_name}}-only replace.
export function mergeTemplate(template: string, recipient: { email: string; firstName?: string | null; lastName?: string | null; company?: string | null; customFields?: string | null }): string {
  const fields: Record<string, string> = {
    first_name: recipient.firstName || recipient.email.split('@')[0],
    last_name: recipient.lastName || '',
    company: recipient.company || '',
    email: recipient.email,
  };
  if (recipient.customFields) {
    try {
      const custom = JSON.parse(recipient.customFields);
      Object.assign(fields, custom);
    } catch { /* ignore malformed custom fields */ }
  }
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => fields[key] !== undefined ? fields[key] : match);
}
