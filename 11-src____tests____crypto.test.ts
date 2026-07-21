import { encrypt, decrypt } from '../crypto';

describe('crypto', () => {
  it('encrypts and decrypts round-trip correctly', () => {
    const original = JSON.stringify({ apiKey: 'secret-value-123' });
    const encrypted = encrypt(original);
    expect(encrypted).not.toEqual(original);
    expect(decrypt(encrypted)).toEqual(original);
  });

  it('produces different ciphertext for the same input each time (random IV)', () => {
    const original = 'same-input';
    expect(encrypt(original)).not.toEqual(encrypt(original));
  });
});
