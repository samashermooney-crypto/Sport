import {
  authLegalResponseSchema,
  authMessageResponseSchema,
  authSignInResponseSchema,
  authStatusResponseSchema,
  changePasswordBodySchema,
  deletionRequestBodySchema,
  deletionRequestResponseSchema,
  emailBodySchema,
  mfaChallengeBodySchema,
  mfaCodeBodySchema,
  mfaEnrollmentResponseSchema,
  recoveryCodesResponseSchema,
  requestEmailChangeBodySchema,
  resetPasswordBodySchema,
  sessionsResponseSchema,
  signInBodySchema,
  signUpSchema,
  stepUpBodySchema,
  tokenBodySchema,
} from '@shared/schemas/auth';
import { apiErrorSchema } from '@shared/schemas/errors';
import type { ErrorCode } from '@shared/schemas/errors';
import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  changePassword,
  confirmEmailChange,
  requestAccountDeletion,
  requestEmailChange,
  requestPasswordReset,
  resetPassword,
} from './credentials';
import type { CredentialsDependencies } from './credentials';
import { AuthDomainError } from './domain-error';
import { localLegalDocuments } from './legal';
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  regenerateRecoveryCodes,
  stepUpWithPassword,
  stepUpWithTotp,
} from './security';
import type { SecurityDependencies } from './security';
import { listActiveSessions, resolveSession, revokeSession } from './sessions';
import type { ActiveSession, IssuedSession } from './sessions';
import {
  completeMfaChallenge,
  EmailVerificationRequiredError,
  InvalidCredentialsError,
  requestMagicLink,
  signInWithMagicLink,
  signInWithPassword,
} from './signin';
import type { SignInDependencies, SignInResult } from './signin';
import { signUp, Under13Error, verifyEmail } from './signup';
import type { SignUpDependencies } from './signup';

export type AuthDependencies = SignUpDependencies &
  SignInDependencies &
  CredentialsDependencies &
  SecurityDependencies;

const cookieName = '__Host-athlentry_session';

class AuthHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function sessionToken(request: Request): string | null {
  const cookies =
    request.headers.cookie?.split(';').map((item) => item.trim()) ?? [];
  const matches = cookies.filter((item) => item.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return null;
  const token = matches[0]?.slice(cookieName.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function setSessionCookie(
  response: Response,
  session: IssuedSession,
  now: Date,
): void {
  response.cookie(cookieName, session.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: session.absoluteExpiresAt.getTime() - now.getTime(),
  });
}

async function requireSession(
  dependencies: AuthDependencies,
  request: Request,
): Promise<ActiveSession> {
  const token = sessionToken(request);
  if (!token)
    throw new AuthHttpError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  const session = await dependencies.database
    .transaction()
    .execute((trx) => resolveSession(trx, token, dependencies.clock()));
  if (!session || session.kind !== 'cookie') {
    throw new AuthHttpError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  }
  return session;
}

function authMeta(request: Request): {
  ip: string | undefined;
  userAgent: string | undefined;
} {
  return { ip: request.ip, userAgent: request.get('user-agent') };
}

function sendSignInResult(
  response: Response,
  result: SignInResult,
  now: Date,
): void {
  if (result.status === 'mfa_required') {
    response.json(authSignInResponseSchema.parse(result));
    return;
  }
  setSessionCookie(response, result.session, now);
  response.json(authSignInResponseSchema.parse({ status: result.status }));
}

export function createAuthRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  const origin = new URL(dependencies.appUrl).origin;
  router.use(express.json({ limit: '32kb' }));
  router.use((request, _response, next) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      (request.get('X-Athlentry-Request') !== '1' ||
        request.get('Origin') !== origin)
    ) {
      next(
        new AuthHttpError(
          403,
          'FORBIDDEN',
          'Request origin could not be verified',
        ),
      );
      return;
    }
    next();
  });

  router.get('/legal', (_request, response) => {
    response.json(authLegalResponseSchema.parse(localLegalDocuments));
  });
  router.post('/sign-up', async (request, response) => {
    const body: unknown = request.body;
    const message = await signUp(
      dependencies,
      signUpSchema.parse(body),
      authMeta(request),
    );
    response.status(202).json(authMessageResponseSchema.parse({ message }));
  });
  router.post('/verify-email', async (request, response) => {
    const body: unknown = request.body;
    const { token } = tokenBodySchema.parse(body);
    if (
      !(await verifyEmail(dependencies.database, token, dependencies.clock()))
    ) {
      throw new AuthHttpError(
        422,
        'INVALID_TOKEN',
        'Verification link is invalid or expired',
      );
    }
    response.json(authStatusResponseSchema.parse({ status: 'verified' }));
  });
  router.post('/sign-in', async (request, response) => {
    const body: unknown = request.body;
    const result = await signInWithPassword(
      dependencies,
      signInBodySchema.parse(body),
      authMeta(request),
    );
    sendSignInResult(response, result, dependencies.clock());
  });
  router.post('/magic/request', async (request, response) => {
    const body: unknown = request.body;
    const message = await requestMagicLink(
      dependencies,
      emailBodySchema.parse(body).email,
    );
    response.status(202).json(authMessageResponseSchema.parse({ message }));
  });
  router.post('/magic/redeem', async (request, response) => {
    const body: unknown = request.body;
    const result = await signInWithMagicLink(
      dependencies,
      tokenBodySchema.parse(body).token,
      authMeta(request),
    );
    sendSignInResult(response, result, dependencies.clock());
  });
  router.post('/mfa/challenge', async (request, response) => {
    const body: unknown = request.body;
    const parsed = mfaChallengeBodySchema.parse(body);
    const session = await completeMfaChallenge(
      dependencies,
      parsed.challengeToken,
      parsed.code,
      parsed.method,
      authMeta(request),
    );
    setSessionCookie(response, session, dependencies.clock());
    response.json(authStatusResponseSchema.parse({ status: 'signed_in' }));
  });
  router.post('/password/reset/request', async (request, response) => {
    const body: unknown = request.body;
    const message = await requestPasswordReset(
      dependencies,
      emailBodySchema.parse(body).email,
    );
    response.status(202).json(authMessageResponseSchema.parse({ message }));
  });
  router.post('/password/reset/confirm', async (request, response) => {
    const body: unknown = request.body;
    const parsed = resetPasswordBodySchema.parse(body);
    if (
      !(await resetPassword(dependencies, parsed.token, parsed.newPassword))
    ) {
      throw new AuthHttpError(
        422,
        'INVALID_TOKEN',
        'Reset link is invalid or expired',
      );
    }
    response.json(authStatusResponseSchema.parse({ status: 'password_reset' }));
  });
  router.post('/password/change', async (request, response) => {
    const session = await requireSession(dependencies, request);
    const body: unknown = request.body;
    const parsed = changePasswordBodySchema.parse(body);
    await changePassword(
      dependencies,
      session,
      parsed.currentPassword,
      parsed.newPassword,
    );
    response.json(
      authStatusResponseSchema.parse({ status: 'password_changed' }),
    );
  });
  router.post('/email/change/request', async (request, response) => {
    const session = await requireSession(dependencies, request);
    const body: unknown = request.body;
    await requestEmailChange(
      dependencies,
      session,
      requestEmailChangeBodySchema.parse(body).email,
    );
    response
      .status(202)
      .json(authStatusResponseSchema.parse({ status: 'verification_sent' }));
  });
  router.post('/email/change/confirm', async (request, response) => {
    const body: unknown = request.body;
    if (
      !(await confirmEmailChange(
        dependencies,
        tokenBodySchema.parse(body).token,
      ))
    ) {
      throw new AuthHttpError(
        422,
        'INVALID_TOKEN',
        'Email-change link is invalid or expired',
      );
    }
    response.clearCookie(cookieName, {
      path: '/',
      secure: true,
      sameSite: 'lax',
    });
    response.json(authStatusResponseSchema.parse({ status: 'email_changed' }));
  });
  router.post('/mfa/enroll/start', async (request, response) => {
    const session = await requireSession(dependencies, request);
    const enrollment = await beginMfaEnrollment(dependencies, session);
    response.setHeader('Cache-Control', 'no-store');
    response.json(mfaEnrollmentResponseSchema.parse(enrollment));
  });
  router.post('/mfa/enroll/confirm', async (request, response) => {
    const session = await requireSession(dependencies, request);
    const body: unknown = request.body;
    const codes = await confirmMfaEnrollment(
      dependencies,
      session,
      mfaCodeBodySchema.parse(body).code,
    );
    response.setHeader('Cache-Control', 'no-store');
    response.json(recoveryCodesResponseSchema.parse({ codes }));
  });
  router.post('/mfa/recovery/regenerate', async (request, response) => {
    const session = await requireSession(dependencies, request);
    const codes = await regenerateRecoveryCodes(dependencies, session);
    response.setHeader('Cache-Control', 'no-store');
    response.json(recoveryCodesResponseSchema.parse({ codes }));
  });
  router.post('/step-up', async (request, response) => {
    const session = await requireSession(dependencies, request);
    const body: unknown = request.body;
    const parsed = stepUpBodySchema.parse(body);
    const accepted =
      parsed.method === 'password'
        ? await stepUpWithPassword(dependencies, session, parsed.password)
        : await stepUpWithTotp(dependencies, session, parsed.code);
    if (!accepted)
      throw new AuthHttpError(
        401,
        'INVALID_CREDENTIALS',
        'Re-authentication failed',
      );
    response.json(authStatusResponseSchema.parse({ status: 'elevated' }));
  });
  router.get('/sessions', async (request, response) => {
    const session = await requireSession(dependencies, request);
    const sessions = await listActiveSessions(
      dependencies.database,
      session.accountId,
      dependencies.clock(),
    );
    response.json(
      sessionsResponseSchema.parse({
        sessions: sessions.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
          lastSeenAt: item.lastSeenAt.toISOString(),
          idleExpiresAt: item.idleExpiresAt.toISOString(),
          absoluteExpiresAt: item.absoluteExpiresAt.toISOString(),
          current: item.id === session.id,
        })),
      }),
    );
  });
  router.delete('/sessions/:id', async (request, response) => {
    const session = await requireSession(dependencies, request);
    const id = z.uuid().parse(request.params.id);
    if (
      !(await dependencies.database
        .transaction()
        .execute((trx) =>
          revokeSession(trx, session.accountId, id, dependencies.clock()),
        ))
    ) {
      throw new AuthHttpError(404, 'NOT_FOUND', 'Session was not found');
    }
    if (id === session.id)
      response.clearCookie(cookieName, {
        path: '/',
        secure: true,
        sameSite: 'lax',
      });
    response.json(authStatusResponseSchema.parse({ status: 'revoked' }));
  });
  router.post('/sign-out', async (request, response) => {
    const session = await requireSession(dependencies, request);
    await dependencies.database
      .transaction()
      .execute((trx) =>
        revokeSession(trx, session.accountId, session.id, dependencies.clock()),
      );
    response.clearCookie(cookieName, {
      path: '/',
      secure: true,
      sameSite: 'lax',
    });
    response.json(authStatusResponseSchema.parse({ status: 'signed_out' }));
  });
  router.post('/account-deletion', async (request, response) => {
    const session = await requireSession(dependencies, request);
    const body: unknown = request.body;
    const id = await requestAccountDeletion(
      dependencies,
      session,
      deletionRequestBodySchema.parse(body).reason,
    );
    response
      .status(202)
      .json(deletionRequestResponseSchema.parse({ requestId: id }));
  });

  // Express identifies error handlers by their four declared parameters.
  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: express.NextFunction,
    ) => {
      if (response.headersSent) {
        _next(error);
        return;
      }
      if (
        error instanceof SyntaxError &&
        'status' in error &&
        error.status === 400
      ) {
        response.status(400).json(
          apiErrorSchema.parse({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request body is not valid JSON',
            },
          }),
        );
        return;
      }
      if (error instanceof z.ZodError) {
        const fields = Object.fromEntries(
          error.issues.map((issue) => [issue.path.join('.'), issue.message]),
        );
        response.status(400).json(
          apiErrorSchema.parse({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Check the submitted fields',
              fields,
            },
          }),
        );
        return;
      }
      if (error instanceof AuthHttpError) {
        response.status(error.status).json(
          apiErrorSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
        return;
      }
      if (error instanceof AuthDomainError) {
        response.status(error.status).json(
          apiErrorSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
        return;
      }
      if (error instanceof Under13Error) {
        response.status(422).json(
          apiErrorSchema.parse({
            error: { code: 'UNDER_13', message: error.message },
          }),
        );
        return;
      }
      if (error instanceof InvalidCredentialsError) {
        response.status(401).json(
          apiErrorSchema.parse({
            error: { code: 'INVALID_CREDENTIALS', message: error.message },
          }),
        );
        return;
      }
      if (error instanceof EmailVerificationRequiredError) {
        response.status(403).json(
          apiErrorSchema.parse({
            error: { code: 'VERIFICATION_REQUIRED', message: error.message },
          }),
        );
        return;
      }
      if (
        error instanceof RangeError &&
        error.message.startsWith('Password rejected:')
      ) {
        response.status(422).json(
          apiErrorSchema.parse({
            error: {
              code: 'WEAK_PASSWORD',
              message: 'Choose a stronger password',
            },
          }),
        );
        return;
      }
      response.status(500).json(
        apiErrorSchema.parse({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The request could not be completed',
          },
        }),
      );
    },
  );
  return router;
}
