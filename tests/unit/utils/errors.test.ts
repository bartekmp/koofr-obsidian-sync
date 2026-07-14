import { beforeEach, describe, expect, it, vi } from 'vitest';

const { NoticeMock } = vi.hoisted(() => ({
	NoticeMock: vi.fn(function (
		this: { message: string; timeout?: number },
		message: string,
		timeout?: number
	) {
		this.message = message;
		this.timeout = timeout;
	}),
}));

vi.mock('obsidian', async () => {
	const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
	return {
		...actual,
		Notice: NoticeMock,
	};
});

import {
	getRetryDelay,
	handleAuthErrors,
	handleSyncErrors,
	isRetryableError,
	parseHttpError,
} from '../../../src/utils/errors';
import { AuthenticationError, KoofrError, RateLimitError } from '../../../src/types';
import { logger } from '../../../src/utils/logger';

function applyDecorator(
	decorator: (
		target: unknown,
		propertyKey: string,
		descriptor: PropertyDescriptor
	) => PropertyDescriptor,
	propertyKey: string,
	error: unknown
): () => Promise<unknown> {
	const descriptor: PropertyDescriptor = {
		value: vi.fn().mockRejectedValue(error),
	};

	decorator({}, propertyKey, descriptor);
	return descriptor.value as () => Promise<unknown>;
}

describe('errors utils', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
	});

	describe('handleSyncErrors', () => {
		it('catches AuthenticationError, logs it, shows a notice, and re-throws', async () => {
			const error = new AuthenticationError('Token expired', 'invalid_grant');
			const wrapped = applyDecorator(handleSyncErrors, 'sync', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.error).toHaveBeenCalledWith('Authentication error during sync:', error);
			expect(NoticeMock).toHaveBeenCalledWith(
				'Koofr authentication failed. Please reconnect in settings.'
			);
		});

		it('catches RateLimitError, logs it, shows a retry notice, and re-throws', async () => {
			const error = new RateLimitError('Too many requests', 120);
			const wrapped = applyDecorator(handleSyncErrors, 'sync', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.warn).toHaveBeenCalledWith('Rate limit reached. Retry after 120 seconds');
			expect(NoticeMock).toHaveBeenCalledWith(
				'Koofr rate limit reached. Will retry in 120 seconds...',
				5000
			);
		});

		it('catches KoofrError, logs it, shows a notice, and re-throws', async () => {
			const error = new KoofrError('API failed', 'bad_request', 400);
			const wrapped = applyDecorator(handleSyncErrors, 'sync', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.error).toHaveBeenCalledWith('Koofr API error:', error);
			expect(NoticeMock).toHaveBeenCalledWith('Koofr error: API failed', 5000);
		});

		it('catches unexpected errors, logs them, shows a notice, and re-throws', async () => {
			const error = new Error('boom');
			const wrapped = applyDecorator(handleSyncErrors, 'sync', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.error).toHaveBeenCalledWith('Unexpected error during sync:', error);
			expect(NoticeMock).toHaveBeenCalledWith(
				'An unexpected error occurred during sync. Check console for details.'
			);
		});
	});

	describe('handleAuthErrors', () => {
		it('logs and shows a generic authentication error notice, then re-throws', async () => {
			const error = new Error('Invalid credentials');
			const wrapped = applyDecorator(handleAuthErrors, 'authenticate', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.error).toHaveBeenCalledWith('Authentication error in authenticate:', error);
			expect(NoticeMock).toHaveBeenCalledWith('Authentication failed: Invalid credentials');
		});
	});

	describe('parseHttpError', () => {
		it('returns AuthenticationError for 401 responses', () => {
			const error = parseHttpError(
				401,
				JSON.stringify({ error: 'invalid_grant', message: 'Token expired' })
			);

			expect(error).toBeInstanceOf(AuthenticationError);
			expect(error).toMatchObject({
				message: 'Token expired',
				code: 'invalid_grant',
				statusCode: 401,
			});
		});

		it('returns AuthenticationError for 403 responses', () => {
			const error = parseHttpError(
				403,
				JSON.stringify({ error: 'forbidden', message: 'Not allowed' })
			);

			expect(error).toBeInstanceOf(AuthenticationError);
			expect(error.statusCode).toBe(401);
		});

		it('returns RateLimitError for 429 responses', () => {
			const error = parseHttpError(429, JSON.stringify({ message: 'Slow down', retry_after: 90 }));

			expect(error).toBeInstanceOf(RateLimitError);
			expect(error).toMatchObject({
				message: 'Slow down',
				retryAfter: 90,
				statusCode: 429,
			});
		});

		it('returns KoofrError for other statuses', () => {
			const error = parseHttpError(
				500,
				JSON.stringify({ error: 'server_error', message: 'Internal failure' })
			);

			expect(error).toBeInstanceOf(KoofrError);
			expect(error).toMatchObject({
				message: 'Internal failure',
				code: 'server_error',
				statusCode: 500,
			});
		});

		it('returns a generic KoofrError for malformed JSON bodies', () => {
			const error = parseHttpError(502, 'not-json');

			expect(error).toBeInstanceOf(KoofrError);
			expect(error).toMatchObject({
				message: 'HTTP 502: not-json',
				statusCode: 502,
			});
		});

		it('returns AuthenticationError for malformed JSON with a 401 status', () => {
			const error = parseHttpError(401, 'not-json');

			expect(error).toBeInstanceOf(AuthenticationError);
			expect(error.statusCode).toBe(401);
		});
	});

	describe('isRetryableError', () => {
		it('returns true for RateLimitError', () => {
			expect(isRetryableError(new RateLimitError('Too many requests', 30))).toBe(true);
		});

		it.each([408, 429, 500, 502, 503, 504])(
			'returns true for retryable KoofrError status %s',
			(statusCode) => {
				expect(isRetryableError(new KoofrError('Retry me', 'code', statusCode))).toBe(true);
			}
		);

		it.each([400, 404])('returns false for non-retryable KoofrError status %s', (statusCode) => {
			expect(isRetryableError(new KoofrError('Do not retry', 'code', statusCode))).toBe(false);
		});

		it('returns true for network and timeout errors', () => {
			expect(isRetryableError(new Error('network request failed'))).toBe(true);
			expect(isRetryableError(new Error('timeout while waiting for response'))).toBe(true);
		});

		it('returns false for generic errors', () => {
			expect(isRetryableError(new Error('some other error'))).toBe(false);
		});
	});

	describe('getRetryDelay', () => {
		it('returns retryAfter in milliseconds for RateLimitError', () => {
			expect(getRetryDelay(new RateLimitError('Too many requests', 45))).toBe(45000);
		});

		it('returns undefined for non-rate-limit errors', () => {
			expect(getRetryDelay(new KoofrError('API failed', 'bad_request', 400))).toBeUndefined();
			expect(getRetryDelay(new Error('boom'))).toBeUndefined();
		});
	});
});
