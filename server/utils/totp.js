const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = (buffer) => {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');

  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(chunk, 2)];
  }

  return output;
};

const base32Decode = (value) => {
  const clean = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');

  let bits = '';
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  return Buffer.from(bytes);
};

const createSecret = () => base32Encode(crypto.randomBytes(20));

const hotp = (secret, counter, digits = 6) => {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % (10 ** digits);

  return String(code).padStart(digits, '0');
};

const verifyTotp = (token, secret, { window = 1, step = 30, digits = 6 } = {}) => {
  const cleanToken = String(token || '').replace(/\D/g, '');
  if (cleanToken.length !== digits || !secret) return false;

  const currentCounter = Math.floor(Date.now() / 1000 / step);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(secret, currentCounter + offset, digits);
    const expectedBuffer = Buffer.from(expected);
    const tokenBuffer = Buffer.from(cleanToken);
    if (expectedBuffer.length === tokenBuffer.length && crypto.timingSafeEqual(expectedBuffer, tokenBuffer)) {
      return true;
    }
  }

  return false;
};

const otpauthUrl = ({ issuer = 'DreamHost', account = 'admin', secret }) => {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const issuerParam = encodeURIComponent(issuer);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuerParam}&algorithm=SHA1&digits=6&period=30`;
};

module.exports = {
  createSecret,
  otpauthUrl,
  verifyTotp,
};
