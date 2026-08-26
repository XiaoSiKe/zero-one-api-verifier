import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = 'v1';

function decodeKey(value) {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('encryptionKey must be a 32-byte key or encoded string');
  }

  const encoded = value.startsWith('base64:')
    ? value.slice('base64:'.length)
    : value;

  if (value.startsWith('hex:')) {
    return Buffer.from(value.slice('hex:'.length), 'hex');
  }

  if (/^[a-f\d]{64}$/i.test(value)) {
    return Buffer.from(value, 'hex');
  }

  return Buffer.from(encoded, 'base64url');
}

function requireKey(value) {
  const key = decodeKey(value);
  if (key.length !== KEY_BYTES) {
    throw new RangeError('encryptionKey must contain exactly 32 bytes');
  }
  return key;
}

function requireAdditionalData(cipher, additionalData) {
  if (additionalData !== undefined && additionalData !== null) {
    cipher.setAAD(Buffer.from(String(additionalData), 'utf8'));
  }
}

/** Returns a persistence-friendly AES-256 key. */
export function generateEncryptionKey() {
  return randomBytes(KEY_BYTES).toString('base64url');
}

/** Encrypts a JSON-compatible value into a versioned string. */
export function encryptPayload(payload, encryptionKey, additionalData) {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new TypeError('payload must be JSON serializable');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, requireKey(encryptionKey), iv);
  requireAdditionalData(cipher, additionalData);

  const ciphertext = Buffer.concat([
    cipher.update(serialized, 'utf8'),
    cipher.final(),
  ]);
  const authenticationTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    authenticationTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Decrypts and parses a value produced by encryptPayload. */
export function decryptPayload(encryptedPayload, encryptionKey, additionalData) {
  if (typeof encryptedPayload !== 'string') {
    throw new TypeError('encryptedPayload must be a string');
  }

  const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
    encryptedPayload.split('.');

  if (
    version !== FORMAT_VERSION ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext ||
    extra !== undefined
  ) {
    throw new Error('Unsupported or malformed encrypted payload');
  }

  try {
    const iv = Buffer.from(encodedIv, 'base64url');
    const authenticationTag = Buffer.from(encodedTag, 'base64url');
    const ciphertext = Buffer.from(encodedCiphertext, 'base64url');
    if (iv.length !== IV_BYTES || authenticationTag.length !== 16) {
      throw new Error('Invalid AES-GCM metadata');
    }

    const decipher = createDecipheriv(ALGORITHM, requireKey(encryptionKey), iv);
    requireAdditionalData(decipher, additionalData);
    decipher.setAuthTag(authenticationTag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');

    return JSON.parse(plaintext);
  } catch (error) {
    throw new Error('Unable to decrypt encrypted payload', { cause: error });
  }
}
