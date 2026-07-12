/**
 * Supplies the `Authorization: Token token=...` header for KoofrClient
 * requests, transparently re-authenticating from stored credentials when
 * a request comes back 401 (Koofr has no refresh-token flow to lean on).
 */

import { CredentialStorage } from './credentialStorage';
import { KoofrAuthClient } from './koofrAuthClient';
import { logger } from '../utils/logger';
import { AuthenticationError } from '../types';

export class KoofrAuthProvider {
	constructor(
		private credentialStorage: CredentialStorage,
		private authClient: KoofrAuthClient,
		private onAuthRequired?: () => Promise<void>
	) {}

	/**
	 * Get a token to use for a request. Returns the cached token if present,
	 * otherwise authenticates fresh from stored credentials.
	 */
	async getToken(): Promise<string> {
		const cached = this.credentialStorage.getCachedToken();
		if (cached) return cached;
		return this.reauthenticate();
	}

	/**
	 * Build the Authorization header value for a request.
	 */
	async getAuthHeader(): Promise<string> {
		return `Token token=${await this.getToken()}`;
	}

	/**
	 * Force a fresh authentication using stored email/password, caching the
	 * new token. Called on initial connect and whenever a request 401s.
	 */
	async reauthenticate(): Promise<string> {
		const email = this.credentialStorage.getEmail();
		const appPassword = this.credentialStorage.getAppPassword();

		if (!email || !appPassword) {
			logger.error('No stored Koofr credentials');
			throw new AuthenticationError('Not authenticated. Please connect to Koofr in settings.');
		}

		try {
			const { token } = await this.authClient.authenticate(email, appPassword);
			this.credentialStorage.setToken(token);
			logger.debug('Re-authenticated with Koofr and cached fresh token');
			return token;
		} catch (error) {
			logger.error('Failed to re-authenticate with Koofr:', error);
			if (this.onAuthRequired) {
				await this.onAuthRequired();
			}
			throw new AuthenticationError('Failed to authenticate with Koofr. Please reconnect.');
		}
	}
}
