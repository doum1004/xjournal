import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * A software WebAuthn authenticator for tests: ES256 keys, 'none' attestation.
 * It produces the same JSON a browser's navigator.credentials returns via @simplewebauthn/browser,
 * so server-side verification runs unmodified. Reusable for Playwright-free e2e tests.
 */

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

// Minimal CBOR encoder: unsigned/negative ints, byte strings, text, maps.
function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([cborHead(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  const parts: Buffer[] = [cborHead(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

interface Credential {
  id: Buffer;
  privateKey: KeyObject;
  cosePublicKey: Buffer;
  counter: number;
  userHandle?: string;
}

export class SoftAuthenticator {
  private creds: Credential[] = [];
  constructor(readonly origin: string) {}

  /** navigator.credentials.create() → RegistrationResponseJSON */
  register(options: { challenge: string; rp: { id?: string }; user?: { id: string } }) {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cosePublicKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
    const id = randomBytes(32);
    const cred: Credential = {
      id,
      privateKey,
      cosePublicKey,
      counter: 0,
      userHandle: options.user?.id,
    };
    this.creds.push(cred);

    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([0x01 | 0x04 | 0x40]), // UP | UV | AT
      Buffer.alloc(4), // signCount 0
      Buffer.alloc(16), // AAGUID
      credIdLen,
      id,
      cosePublicKey,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: 'public-key' as const,
      authenticatorAttachment: 'platform' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** navigator.credentials.get() → AuthenticationResponseJSON (uses the latest credential). */
  authenticate(options: { challenge: string; rpId?: string }) {
    const cred = this.creds.at(-1);
    if (!cred) throw new Error('no credential registered');
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    cred.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(cred.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([0x01 | 0x04]), counter]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      cred.privateKey,
    );
    return {
      id: b64url(cred.id),
      rawId: b64url(cred.id),
      type: 'public-key' as const,
      authenticatorAttachment: 'platform' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(cred.userHandle ? { userHandle: cred.userHandle } : {}),
      },
    };
  }
}
