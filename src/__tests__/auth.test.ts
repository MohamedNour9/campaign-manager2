import jwt from 'jsonwebtoken';

describe('auth', () => {
  let checkUnlockPassword: typeof import('../auth').checkUnlockPassword;

  beforeEach(() => {
    // Reset module registry so each test imports fresh with its own env vars
    jest.resetModules();
  });

  describe('checkUnlockPassword', () => {
    it('returns "unlocked" when APP_PASSWORD is empty (open mode)', () => {
      process.env.APP_PASSWORD = '';
      process.env.JWT_SECRET = 'test-secret';
      ({ checkUnlockPassword } = require('../auth'));
      expect(checkUnlockPassword('anything')).toBe('unlocked');
    });

    it('returns null for an empty password', () => {
      process.env.APP_PASSWORD = 'secret123';
      process.env.JWT_SECRET = 'test-secret';
      ({ checkUnlockPassword } = require('../auth'));
      expect(checkUnlockPassword('')).toBeNull();
    });

    it('returns null for an incorrect password', () => {
      process.env.APP_PASSWORD = 'secret123';
      process.env.JWT_SECRET = 'test-secret';
      ({ checkUnlockPassword } = require('../auth'));
      expect(checkUnlockPassword('wrong-password')).toBeNull();
    });

    it('returns a JWT token for the correct password', () => {
      process.env.APP_PASSWORD = 'admin123';
      process.env.JWT_SECRET = 'test-secret';
      ({ checkUnlockPassword } = require('../auth'));
      const token = checkUnlockPassword('admin123');
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      // Verify it's a valid JWT
      const decoded = jwt.verify(token!, 'test-secret') as any;
      expect(decoded.session).toBe(true);
    });
  });
});
