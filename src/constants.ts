/**
 * Constants for Koofr API integration
 */

// Koofr REST API v2
export const KOOFR_API_BASE = 'https://app.koofr.net';
export const KOOFR_TOKEN_ENDPOINT = `${KOOFR_API_BASE}/token`;
export const KOOFR_API_V2 = `${KOOFR_API_BASE}/api/v2`;
export const KOOFR_CONTENT_API_V2 = `${KOOFR_API_BASE}/content/api/v2`;

// Sync configuration
export const SYNC_CONFIG = {
	// Throttle delay for vault events (milliseconds)
	EVENT_THROTTLE_MS: 3000,
};

// Plugin metadata
export const PLUGIN_INFO = {
	NAME: 'Koofr Sync',
	ID: 'koofr-sync',
	VERSION: '0.1.0',
};

// Link shown in settings for generating an app-specific password
export const KOOFR_APP_PASSWORD_URL = 'https://app.koofr.net/app/admin/preferences/password';

/**
 * Discrete stops for the "Automatic sync interval" slider, in minutes.
 * 0 means manual-only. The slider itself is index-based over this list so
 * ticks are evenly spaced regardless of how unevenly the minute values grow.
 */
export const SYNC_INTERVAL_OPTIONS: ReadonlyArray<{ minutes: number; label: string }> = [
	{ minutes: 0, label: 'Manual' },
	{ minutes: 1, label: '1 min' },
	{ minutes: 5, label: '5 min' },
	{ minutes: 15, label: '15 min' },
	{ minutes: 30, label: '30 min' },
	{ minutes: 60, label: '1 hour' },
	{ minutes: 120, label: '2 hours' },
	{ minutes: 240, label: '4 hours' },
];
