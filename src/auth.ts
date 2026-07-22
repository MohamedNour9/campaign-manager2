import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const prisma = new PrismaClient();

// Single-owner app — no login/register system. Everything belongs to one fixed
// account, seeded automatically on first boot.
export const OWNER_ID = 'owner';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@local';
const SESSION_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const APP_PASSWORD = process.env.APP_PASSWORD; // if unset, site is fully open — not recommended

export async function ensureOwnerSeeded() {
  const existing = await prisma.user.findUnique({ where: { id: OWNER_ID } });
  if (!existing) {
    await prisma.user.create({ data: { id: OWNER_ID, email: OWNER_EMAIL, password: 'n/a' } });
    console.log('👤 Owner account seeded automatically — no login required.');
  }
}

export interface AuthedRequest extends Request {
  userId?: string;
}

// Attaches the fixed owner id to every request. No token, no login screen.
export function attachOwner(req: AuthedRequest, _res: Response, next: NextFunction) {
  req.userId = OWNER_ID;
  next();
}

// Constant-time string compare — avoids leaking password length/prefix via response timing.
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // burn equivalent time either way
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// One-time unlock: person enters a single shared password (set via APP_PASSWORD env var),
// gets a session token back. Not a user login system — just a door lock on the whole site.
export function checkUnlockPassword(password: string): string | null {
  if (!APP_PASSWORD) return 'unlocked'; // no password configured — site is open, always "unlocked"
  if (!password || !safeCompare(password, APP_PASSWORD)) return null;
  return jwt.sign({ session: true }, SESSION_SECRET, { expiresIn: '30d' });
}

// Gate every API route behind the shared-password session token, unless no
// APP_PASSWORD was configured (fully open mode).
export function requireUnlock(req: Request, res: Response, next: NextFunction) {
  if (!APP_PASSWORD) return next(); // open mode
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Locked — password required' });
  try {
    jwt.verify(header.split(' ')[1], SESSION_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired — enter password again' });
  }
}
