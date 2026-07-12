/**
 * Koofr authentication client — POST /token with email + app-specific password.
 *
 * ## Why not OAuth?
 *
 * Koofr's public integration surface for third-party apps is HTTP Basic-style
 * token auth, not OAuth: generate an app-specific password in the Koofr web
 * app (Preferences → Password → App passwords), then exchange
 * `{email, password}` for a token via `POST /token`. There is no documented
 * token refresh endpoint, so `KoofrAuthProvider` re-authenticates from the
 * stored email/password whenever a request comes back 401 rather than
 * tracking an expiry window.
 *
 * @see https://koofr.eu/help/koofr_with_webdav/which-password-to-use-when-connecting-via-webdav/
 */

import { requestUrl } from 'obsidian';
import { KoofrTokenResponse, AuthenticationError } from '../types';
import { KOOFR_TOKEN_ENDPOINT } from '../constants';
import { logger } from '../utils/logger';
import { parseHttpError } from '../utils/errors';

export class KoofrAuthClient {
	/**
	 * Exchange email + app password for an auth token.
	 */
	async authenticate(email: string, password: string): Promise<KoofrTokenResponse> {
		logger.debug('Authenticating with Koofr', { email });

		try {
			const response = await requestUrl({
				url: KOOFR_TOKEN_ENDPOINT,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ email, password }),
				throw: false,
			});

			if (response.status !== 200) {
				throw parseHttpError(response.status, response.text);
			}

			const data = response.json as unknown as { token?: string; Token?: string };
			const token = data.token || data.Token;
			if (!token) {
				throw new AuthenticationError('Koofr did not return an auth token');
			}

			logger.info('Koofr authentication successful');
			return { token };
		} catch (error) {
			if (error instanceof AuthenticationError) {
				throw error;
			}
			logger.error('Koofr authentication failed:', error);
			throw new AuthenticationError(
				`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}
}
