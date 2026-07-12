/**
 * Credential storage using Obsidian's SecretStorage API.
 * Email, app password, and the cached auth token are stored securely
 * outside of data.json — never in plain settings.
 */

import { App } from 'obsidian';
import { StoredCredentials } from '../types';
import { logger } from '../utils/logger';

const SECRET_KEYS = {
	EMAIL: 'email',
	APP_PASSWORD: 'app-password',
	TOKEN: 'token',
} as const;

/**
 * Credential storage manager using Obsidian's SecretStorage
 */
export class CredentialStorage {
	private credentials?: StoredCredentials;
	private app?: App;

	/**
	 * Set the app reference for SecretStorage access
	 */
	setApp(app: App): void {
		this.app = app;
	}

	/**
	 * Load credentials from SecretStorage.
	 */
	loadCredentials(): void {
		if (!this.app) {
			logger.error('App not set on CredentialStorage');
			return;
		}

		const email = this.app.secretStorage.getSecret(SECRET_KEYS.EMAIL);
		const appPassword = this.app.secretStorage.getSecret(SECRET_KEYS.APP_PASSWORD);
		const token = this.app.secretStorage.getSecret(SECRET_KEYS.TOKEN);

		if (email && appPassword) {
			this.credentials = { email, appPassword, token: token || undefined };
			logger.debug('Credentials loaded from SecretStorage');
		} else {
			this.credentials = undefined;
		}
	}

	/**
	 * Store email + app password (and clear any stale cached token — the
	 * caller should set a fresh one via setToken after authenticating).
	 */
	setCredentials(email: string, appPassword: string): void {
		this.credentials = { email, appPassword, token: undefined };
		this.saveToSecretStorage();
		logger.debug('Credentials stored in SecretStorage');
	}

	/**
	 * Cache a freshly-issued auth token alongside the stored credentials.
	 */
	setToken(token: string): void {
		if (!this.credentials) return;
		this.credentials.token = token;
		this.saveToSecretStorage();
	}

	private saveToSecretStorage(): void {
		if (!this.app || !this.credentials) return;

		this.app.secretStorage.setSecret(SECRET_KEYS.EMAIL, this.credentials.email);
		this.app.secretStorage.setSecret(SECRET_KEYS.APP_PASSWORD, this.credentials.appPassword);
		this.app.secretStorage.setSecret(SECRET_KEYS.TOKEN, this.credentials.token || '');
	}

	getEmail(): string | undefined {
		return this.credentials?.email;
	}

	getAppPassword(): string | undefined {
		return this.credentials?.appPassword;
	}

	getCachedToken(): string | undefined {
		return this.credentials?.token;
	}

	hasCredentials(): boolean {
		return !!this.credentials;
	}

	/**
	 * Clear credentials from both memory and SecretStorage
	 */
	clearCredentials(): void {
		this.credentials = undefined;
		if (this.app) {
			this.app.secretStorage.setSecret(SECRET_KEYS.EMAIL, '');
			this.app.secretStorage.setSecret(SECRET_KEYS.APP_PASSWORD, '');
			this.app.secretStorage.setSecret(SECRET_KEYS.TOKEN, '');
		}
		logger.debug('Credentials cleared');
	}
}
