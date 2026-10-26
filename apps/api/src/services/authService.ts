import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiConfig } from '../config/env.js';

export interface SessionTokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

export function issueSessionToken(
  config: ApiConfig,
  userId: string,
  nowMs = Date.now()
): { token: string; expiresAt: string; userId: string } {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + config.authTokenTtlSeconds;
  const payload: SessionTokenPayload = { sub: userId, iat, exp };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString(
    'base64url'
  );
  const signature = crypto
    .createHmac('sha256', config.authSecret)
    .update(payloadB64)
    .digest('base64url');
  return {
    token: `${payloadB64}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    userId,
  };
}

export function verifySessionToken(
  config: ApiConfig,
  token: string,
  nowMs = Date.now()
): SessionTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payloadB64, providedSig] = parts;
  if (!payloadB64 || !providedSig) {
    return null;
  }

  const expectedSig = crypto
    .createHmac('sha256', config.authSecret)
    .update(payloadB64)
    .digest('base64url');

  const bufA = Buffer.from(providedSig, 'utf-8');
  const bufB = Buffer.from(expectedSig, 'utf-8');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf-8')
    ) as SessionTokenPayload;
    const nowSec = Math.floor(nowMs / 1000);
    if (
      typeof parsed.sub !== 'string' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp <= nowSec
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function verifyAccessCodeConstantTime(
  expectedCode: string,
  providedCode: string
): boolean {
  const hashExpected = crypto
    .createHash('sha256')
    .update(expectedCode)
    .digest();
  const hashProvided = crypto
    .createHash('sha256')
    .update(providedCode)
    .digest();
  return crypto.timingSafeEqual(hashExpected, hashProvided);
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

export function createAuthPreHandler(config: ApiConfig) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim();
      const verified = verifySessionToken(config, token);
      if (verified) {
        request.userId = verified.sub;
        return;
      }
    }

    const accessCodeHeader = request.headers['x-access-code'];
    if (
      typeof accessCodeHeader === 'string' &&
      verifyAccessCodeConstantTime(
        config.authDefaultAccessCode,
        accessCodeHeader
      )
    ) {
      request.userId = config.authDefaultUserId;
      return;
    }

    await reply.status(401).send({
      error: 'UNAUTHORIZED',
      message: 'Требуется действительный токен авторизации.',
    });
  };
}
