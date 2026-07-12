/**
 * Error handling utilities and custom error classes
 * Implementation pattern inspired by Home Assistant's error decorator
 */

import { Notice } from 'obsidian';
import { AuthenticationError, RateLimitError, KoofrError } from '../types';
import { logger } from './logger';

type DecoratedAsyncMethod = (this: object, ...args: unknown[]) => Promise<unknown>;

interface ParsedHttpErrorBody {
	error?: string;
	message?: string;
	retry_after?: number;
}

function getDecoratedMethod(descriptor: PropertyDescriptor): DecoratedAsyncMethod {
	if (typeof descriptor.value !== 'function') {
		throw new Error('Decorator can only be applied to methods');
	}

	return descriptor.value as DecoratedAsyncMethod;
}

/**
 * Decorator to handle sync errors gracefully
 * Inspired by Home Assistant's @handle_backup_errors pattern
 */
export function handleSyncErrors(
	target: unknown,
	propertyKey: string,
	descriptor: PropertyDescriptor
) {
	const originalMethod = getDecoratedMethod(descriptor);

	descriptor.value = async function (this: object, ...args: unknown[]) {
		try {
			return await Reflect.apply(originalMethod, this, args);
		} catch (error) {
			if (error instanceof AuthenticationError) {
				logger.error('Authentication error during sync:', error);
				new Notice('Koofr authentication failed. Please reconnect in settings.');
				throw error; // Re-throw to trigger re-auth flow
			} else if (error instanceof RateLimitError) {
				const retryAfter = error.retryAfter || 60;
				logger.warn(`Rate limit reached. Retry after ${retryAfter} seconds`);
				new Notice(`Koofr rate limit reached. Will retry in ${retryAfter} seconds...`, 5000);
				throw error;
			} else if (error instanceof KoofrError) {
				logger.error('Koofr API error:', error);
				new Notice(`Koofr error: ${error.message}`, 5000);
				throw error;
			} else {
				logger.error('Unexpected error during sync:', error);
				new Notice('An unexpected error occurred during sync. Check console for details.');
				throw error;
			}
		}
	};

	return descriptor;
}

/**
 * Decorator to handle authentication errors
 */
export function handleAuthErrors(
	target: unknown,
	propertyKey: string,
	descriptor: PropertyDescriptor
) {
	const originalMethod = getDecoratedMethod(descriptor);

	descriptor.value = async function (this: object, ...args: unknown[]) {
		try {
			return await Reflect.apply(originalMethod, this, args);
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Authentication error in ${propertyKey}:`, error);
				new Notice(`Authentication failed: ${error.message}`);
			}
			throw error;
		}
	};

	return descriptor;
}

/**
 * Parse error from an HTTP response body returned by the Koofr API.
 */
export function parseHttpError(status: number, body: string): Error {
	try {
		const json = JSON.parse(body) as ParsedHttpErrorBody;
		const errorCode = json.error || 'unknown_error';
		const errorMessage = json.message || errorCode || 'Unknown error occurred';

		if (status === 401 || status === 403) {
			return new AuthenticationError(errorMessage, errorCode);
		} else if (status === 429) {
			const retryAfter = json.retry_after || 60;
			return new RateLimitError(errorMessage, retryAfter);
		} else {
			return new KoofrError(errorMessage, errorCode, status);
		}
	} catch {
		// Failed to parse JSON, return generic error
		if (status === 401 || status === 403) {
			return new AuthenticationError(`HTTP ${status}: ${body}`);
		}
		return new KoofrError(`HTTP ${status}: ${body}`, undefined, status);
	}
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: Error): boolean {
	if (error instanceof RateLimitError) {
		return true;
	}

	const retryableStatusCodes = [408, 429, 500, 502, 503, 504];

	if (error instanceof KoofrError) {
		return error.statusCode ? retryableStatusCodes.includes(error.statusCode) : false;
	}

	if (error && typeof error === 'object' && 'statusCode' in error) {
		const statusCode = (error as unknown as { statusCode: number }).statusCode;
		if (typeof statusCode === 'number') {
			return retryableStatusCodes.includes(statusCode);
		}
	}

	// Network errors are retryable
	if (error.message.includes('network') || error.message.includes('timeout')) {
		return true;
	}

	return false;
}

/**
 * Extract retry delay from error
 */
export function getRetryDelay(error: Error): number | undefined {
	if (error instanceof RateLimitError) {
		return (error.retryAfter || 60) * 1000; // Convert to milliseconds
	}
	return undefined;
}
