/**
 * Koofr Sync Plugin for Obsidian
 * Syncs vault with Koofr cloud storage using email + app-specific password
 */

import { Platform, Plugin, Notice, TFile } from 'obsidian';
import {
	PluginSettings,
	DEFAULT_SETTINGS,
	DEFAULT_EXPERIMENTAL_SETTINGS,
	ExperimentalSettings,
	KoofrFileInfo,
	KoofrMount,
} from './types';
import { logger, LogLevel } from './utils/logger';
import { shouldSyncVaultPath } from './utils/pathUtils';
import {
	applyVaultLogHook as applyPluginVaultLogHook,
	type VaultLogAdapter,
} from './utils/logManager';
import {
	ensureSelfInCommunityPluginsList as guardCommunityPluginsList,
	type CommunityPluginsAdapter,
} from './utils/pluginListGuard';

// Auth
import { CredentialStorage } from './auth/credentialStorage';
import { KoofrAuthClient } from './auth/koofrAuthClient';
import { KoofrAuthProvider } from './auth/koofrAuthProvider';

// API
import { KoofrClient } from './api/koofrClient';
import { FileOperations } from './api/fileOperations';

// Sync
import { SyncEngine } from './sync/syncEngine';
import { SyncStateManager } from './sync/syncState';
import { ConflictResolver } from './sync/conflictResolver';
import { ConflictQueue } from './sync/conflictQueue';
import { EventManager } from './sync/eventManager';

// UI
import { KoofrSettingTab } from './ui/settings';
import { StatusBarManager, SyncStatus } from './ui/statusBar';
import { FolderSelection } from './ui/folderBrowserModal';
import { ConflictView, CONFLICT_VIEW_TYPE } from './ui/conflictView';
import { LargeDeleteWarningModal } from './ui/modals';

import { LargeDeleteWarningInfo, LargeDeleteDecision } from './types';

import { t } from './i18n';
import { timerApi } from './utils/timerApi';

export interface SyncStatusInfo {
	status: SyncStatus;
	lastSyncTime?: number;
	progressMessage?: string;
	conflictCount: number;
}

function isCommunityPluginsAdapter(adapter: unknown): adapter is CommunityPluginsAdapter {
	if (!adapter || typeof adapter !== 'object') {
		return false;
	}

	const candidate = adapter as Record<string, unknown>;
	return ['exists', 'read', 'write'].every((key) => typeof candidate[key] === 'function');
}

function isVaultLogAdapter(adapter: unknown): adapter is VaultLogAdapter {
	if (!adapter || typeof adapter !== 'object') {
		return false;
	}

	const candidate = adapter as Record<string, unknown>;
	return ['exists', 'mkdir', 'write', 'append'].every(
		(key) => typeof candidate[key] === 'function'
	);
}

/**
 * Main plugin class
 */
export default class KoofrSyncPlugin extends Plugin {
	settings: PluginSettings;

	// Core components
	private credentialStorage: CredentialStorage;
	private authClient: KoofrAuthClient;
	private authProvider?: KoofrAuthProvider;
	private koofrClient?: KoofrClient;
	private fileOps?: FileOperations;
	private syncEngine?: SyncEngine;
	private syncStateManager: SyncStateManager;
	private conflictResolver: ConflictResolver;
	private conflictQueue?: ConflictQueue;
	private eventManager?: EventManager;

	// Sync state
	private isSyncing = false;

	// UI components
	private statusBarManager?: StatusBarManager;
	private currentSyncStatus: SyncStatus = SyncStatus.DISCONNECTED;
	private currentProgressMessage?: string;
	private mobileProgressNotice?: Notice;

	async onload() {
		logger.info('Loading Koofr Sync plugin');

		await this.loadSettings();

		// Self-heal our entry in community-plugins.json — see pluginListGuard.ts
		await this.ensureSelfInCommunityPluginsList();

		// Initialize core components
		this.credentialStorage = new CredentialStorage();
		this.credentialStorage.setApp(this.app);
		this.authClient = new KoofrAuthClient();
		this.syncStateManager = new SyncStateManager();
		this.conflictResolver = new ConflictResolver(this.settings.conflictResolution);

		// Configure logger early so migration logs are captured
		this.applyLogLevel();
		this.applyVaultLogHook();

		this.credentialStorage.loadCredentials();
		this.syncStateManager.loadState(this.settings.syncState);

		if (this.credentialStorage.hasCredentials()) {
			await this.initializeAuthenticatedComponents();
		}

		// Add ribbon icon for manual sync
		this.addRibbonIcon('cloud', t('ribbon.syncNow'), async () => {
			await this.triggerManualSync();
		});

		// Add commands
		this.addCommand({
			id: 'sync-now',
			name: t('commands.syncNow'),
			callback: async () => {
				await this.triggerManualSync();
			},
		});

		this.addCommand({
			id: 'disconnect-koofr',
			name: t('commands.disconnect'),
			callback: async () => {
				await this.disconnect();
			},
		});

		this.addCommand({
			id: 'force-full-sync',
			name: t('commands.forceFullSync'),
			callback: async () => {
				this.syncStateManager.clearState();
				await this.saveSettings();
				new Notice(t('notices.sync.stateCleared'));
				await this.triggerManualSync();
			},
		});

		this.addCommand({
			id: 'reconcile-from-cloud',
			name: t('commands.reconcileFromCloud'),
			callback: async () => {
				await this.reconcileFromCloud();
			},
		});

		this.addCommand({
			id: 'show-conflicts',
			name: t('commands.showConflicts'),
			callback: () => {
				void this.activateConflictView();
			},
		});

		this.addCommand({
			id: 'dev-create-test-conflict',
			name: t('commands.devCreateTestConflict'),
			callback: async () => {
				await this.createTestConflict();
			},
		});

		// Register conflict view
		this.registerView(CONFLICT_VIEW_TYPE, (leaf) => {
			if (!this.conflictQueue) {
				throw new Error('Conflict queue not initialized');
			}
			return new ConflictView(leaf, this.conflictQueue, async () => {
				await this.saveSettings();
				this.updateConflictCount();
			});
		});

		// Add status bar item
		const statusBarItem = this.addStatusBarItem();
		this.statusBarManager = new StatusBarManager(statusBarItem, () => {
			void this.triggerManualSync();
		});
		this.updateStatusBar();

		// Add settings tab
		this.addSettingTab(new KoofrSettingTab(this.app, this));

		// Start event listeners and periodic sync only if sync target is configured
		if (this.credentialStorage.hasCredentials() && this.eventManager && this.isSyncConfigured()) {
			this.eventManager.startListening();
			this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
		}

		// Perform startup sync if configured and sync target is set
		if (
			this.credentialStorage.hasCredentials() &&
			this.settings.startupSyncDelay > 0 &&
			this.isSyncConfigured()
		) {
			timerApi.setTimeout(() => {
				void this.triggerManualSync();
			}, this.settings.startupSyncDelay * 1000);
		}

		logger.info('Koofr Sync plugin loaded successfully');
	}

	onunload() {
		logger.info('Unloading Koofr Sync plugin');
		this.hideMobileProgressNotice();

		if (this.eventManager) {
			this.eventManager.stopListening();
		}

		logger.info('Koofr Sync plugin unloaded');
	}

	/**
	 * Initialize authenticated components (API client, sync engine)
	 */
	private async initializeAuthenticatedComponents() {
		logger.info('Initializing authenticated components');

		try {
			this.authProvider = new KoofrAuthProvider(this.credentialStorage, this.authClient, async () => {
				new Notice(t('notices.auth.expired'));
			});

			this.koofrClient = new KoofrClient(this.authProvider, this.settings.mountId);
			this.fileOps = new FileOperations(
				this.koofrClient,
				() => this.getExperimentalSetting('skipFolderChecks')
			);

			this.eventManager = new EventManager(
				this.app,
				async () => {
					await this.performSync();
				},
				this.syncStateManager,
				(path) =>
					shouldSyncVaultPath(
						path,
						this.settings.syncPluginManifests,
						this.settings.syncAppSettings,
						this.app.vault.configDir,
						this.settings.syncCssSnippets
					)
			);
			this.eventManager.setPullOnlyModeCheck(() => this.getExperimentalSetting('pullOnlyMode'));

			this.conflictQueue = new ConflictQueue(
				this.app,
				this.syncStateManager,
				this.eventManager,
				this.app.vault.configDir
			);
			this.conflictQueue.load(this.settings.conflictQueue);

			// A remotePath of "/" means the user chose the mount root itself,
			// which is equivalent to an empty base path (no prefix).
			const configuredPath = this.settings.remotePath || '';
			const remoteRoot = configuredPath === '/' ? '' : configuredPath;

			this.syncEngine = new SyncEngine(
				this.app,
				this.fileOps,
				this.syncStateManager,
				this.conflictResolver,
				this.eventManager,
				this.app.vault.configDir,
				{
					remoteRoot,
					conflictQueue: this.conflictQueue,
					shouldSyncPath: (path) =>
						shouldSyncVaultPath(
							path,
							this.settings.syncPluginManifests,
							this.settings.syncAppSettings,
							this.app.vault.configDir,
							this.settings.syncCssSnippets
						),
					getLargeDeleteThreshold: () => this.settings.largeDeleteThreshold ?? 0,
					largeDeleteWarningHandler: (info) => this.handleLargeDeleteWarning(info),
					onProgress: (msg) => this.setSyncProgress(msg),
					pluginVersion: this.manifest.version,
					maxConcurrentOperations: this.getExperimentalSetting('maxConcurrentOperations'),
					useAtomicMoves: this.getExperimentalSetting('useAtomicMoves'),
					isPullOnlyMode: () => this.getExperimentalSetting('pullOnlyMode'),
				}
			);

			logger.info('Authenticated components initialized');
		} catch (error) {
			logger.error('Failed to initialize authenticated components:', error);
			new Notice(t('notices.auth.clientInitFailed'));
		}
	}

	/**
	 * Authenticate with Koofr using email + app-specific password
	 */
	async authenticate(email: string, appPassword: string): Promise<void> {
		logger.info('Authenticating with Koofr');

		try {
			const { token } = await this.authClient.authenticate(email, appPassword);
			this.credentialStorage.setCredentials(email, appPassword);
			this.credentialStorage.setToken(token);

			this.settings.connectedEmail = email;
			await this.saveSettings();

			await this.initializeAuthenticatedComponents();

			if (this.eventManager && this.isSyncConfigured()) {
				this.eventManager.startListening();
				this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
			} else {
				new Notice(t('notices.sync.selectFolderFirst'));
			}

			this.updateStatusBar();

			logger.info('Authentication successful');
			new Notice(t('notices.auth.connectSuccess'));
		} catch (error) {
			logger.error('Authentication failed:', error);
			new Notice(
				t('notices.auth.connectFailed', {
					message: error instanceof Error ? error.message : t('notices.common.unknownError'),
				})
			);
			throw error;
		}
	}

	/**
	 * Disconnect from Koofr
	 */
	async disconnect(): Promise<void> {
		logger.info('Disconnecting from Koofr');

		if (this.eventManager) {
			this.eventManager.stopListening();
		}

		this.credentialStorage.clearCredentials();

		this.settings.connectedEmail = undefined;
		this.settings.mountId = undefined;
		this.settings.mountName = undefined;
		this.settings.remotePath = undefined;

		this.authProvider = undefined;
		this.koofrClient = undefined;
		this.fileOps = undefined;
		this.syncEngine = undefined;
		this.eventManager = undefined;

		await this.saveSettings();

		this.updateStatusBar();

		logger.info('Disconnected from Koofr');
		new Notice(t('notices.auth.disconnectSuccess'));
	}

	/**
	 * Check if sync target is fully configured
	 */
	private isSyncConfigured(): boolean {
		return !!this.settings.mountId;
	}

	/**
	 * Trigger manual sync
	 */
	async triggerManualSync(): Promise<void> {
		if (!this.credentialStorage.hasCredentials()) {
			new Notice(t('notices.sync.notConnected'));
			return;
		}

		if (!this.isSyncConfigured()) {
			new Notice(t('notices.sync.selectFolderFirst'));
			return;
		}

		if (!this.syncEngine) {
			new Notice(t('notices.sync.engineNotInitialized'));
			return;
		}

		if (this.eventManager?.isSyncInProgress()) {
			new Notice(t('notices.sync.alreadyInProgress'));
			return;
		}

		if (this.eventManager) {
			await this.eventManager.triggerManualSync();
		} else {
			await this.performSync();
		}
	}

	/**
	 * Perform sync operation
	 */
	private async performSync(): Promise<void> {
		if (!this.syncEngine) {
			logger.warn('Sync engine not initialized');
			return;
		}

		if (this.isSyncing) {
			logger.debug('Sync already in progress, skipping');
			return;
		}

		this.isSyncing = true;
		try {
			this.setSyncStatus(SyncStatus.SYNCING);

			await this.syncEngine.performSync();

			const now = Date.now();
			this.statusBarManager?.setLastSyncTime(now);
			this.setSyncStatus(SyncStatus.IDLE);

			this.updateConflictCount();
			if (this.conflictQueue && this.conflictQueue.count > 0) {
				void this.activateConflictView();
			}

			await this.saveSettings();

			logger.info('Sync completed successfully');
		} catch (error) {
			logger.error('Sync failed:', error);
			this.setSyncStatus(SyncStatus.ERROR);
			const errorMsg = error instanceof Error ? error.message : t('notices.common.unknownError');
			new Notice(t('notices.sync.failed', { message: errorMsg }));
			throw error;
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Update status bar based on current state
	 */
	private updateStatusBar(): void {
		if (!this.statusBarManager) return;

		if (this.credentialStorage.hasCredentials()) {
			const lastSyncTime = this.syncStateManager.getLastSyncTime();
			if (lastSyncTime > 0) {
				this.statusBarManager.setLastSyncTime(lastSyncTime);
			}
			this.setSyncStatus(SyncStatus.IDLE);
		} else {
			this.setSyncStatus(SyncStatus.DISCONNECTED);
		}
	}

	getSyncStatusInfo(): SyncStatusInfo {
		const lastSyncTime = this.syncStateManager.getLastSyncTime();
		return {
			status: this.currentSyncStatus,
			lastSyncTime: lastSyncTime > 0 ? lastSyncTime : undefined,
			progressMessage: this.currentProgressMessage,
			conflictCount: this.conflictQueue?.count ?? 0,
		};
	}

	/**
	 * List mounts for the folder picker's mount-selection step.
	 */
	async listMounts(): Promise<KoofrMount[]> {
		if (!this.koofrClient) {
			throw new Error('Not connected to Koofr');
		}
		return this.koofrClient.listMounts();
	}

	/**
	 * List folders at a path within a given mount for the folder picker.
	 * The mount being browsed may differ from the one currently configured.
	 */
	async listFoldersForPicker(mountId: string, path: string): Promise<KoofrFileInfo[]> {
		if (!this.koofrClient) {
			throw new Error('Not connected to Koofr');
		}
		return this.koofrClient.listFolder(path, mountId);
	}

	/**
	 * Called when the user selects a new mount/folder from the picker.
	 * Stores settings, clears stale sync state, and reconfigures components.
	 */
	async onRemoteFolderChanged(selection: FolderSelection): Promise<void> {
		logger.info('Remote folder changed:', selection);

		const oldMountId = this.settings.mountId;
		const oldPath = this.settings.remotePath;

		this.settings.mountId = selection.mountId;
		this.settings.mountName = selection.mountName;
		this.settings.remotePath = selection.path;

		if (oldMountId !== selection.mountId || oldPath !== selection.path) {
			this.syncStateManager.clearState();
			this.resetDeviceSpecificSyncSettings();
			logger.info('Cleared sync state due to remote folder change');
		}

		await this.saveSettings();

		if (this.credentialStorage.hasCredentials()) {
			await this.initializeAuthenticatedComponents();

			if (this.eventManager && this.isSyncConfigured()) {
				this.eventManager.startListening();
				this.eventManager.startPeriodicSync(this.settings.syncInterval || 0);
			}
		}

		new Notice(t('notices.sync.folderSet', { mount: selection.mountName, path: selection.path }));
		new Notice(t('notices.sync.deviceTypeSyncHint'));
	}

	private resetDeviceSpecificSyncSettings(): void {
		this.settings.syncAppSettings = false;
		this.settings.syncPluginManifests = false;
		this.settings.syncCssSnippets = false;
	}

	/**
	 * Activate (or reveal) the conflict resolution view
	 */
	private async activateConflictView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(CONFLICT_VIEW_TYPE);
		if (existing.length > 0) {
			void this.app.workspace.revealLeaf(existing[0]);
			const view = existing[0].view;
			if (view instanceof ConflictView) {
				await view.renderView();
			}
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: CONFLICT_VIEW_TYPE, active: true });
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	/**
	 * Update the conflict count in the status bar
	 */
	private updateConflictCount(): void {
		const count = this.conflictQueue?.count ?? 0;
		this.statusBarManager?.setConflictCount(count);
	}

	private setSyncStatus(status: SyncStatus): void {
		this.currentSyncStatus = status;
		if (status !== SyncStatus.SYNCING) {
			this.currentProgressMessage = undefined;
		}
		this.statusBarManager?.setStatus(status);
		this.updateMobileProgressNotice();
	}

	private setSyncProgress(message: string | undefined): void {
		this.currentProgressMessage = message;
		this.statusBarManager?.setProgress(message);
		this.updateMobileProgressNotice();
	}

	private updateMobileProgressNotice(): void {
		if (!this.isMobileClient()) return;
		if (this.currentSyncStatus !== SyncStatus.SYNCING) {
			this.hideMobileProgressNotice();
			return;
		}

		const message = this.currentProgressMessage
			? t('mobileProgress.withProgress', { progress: this.currentProgressMessage })
			: t('mobileProgress.inProgress');

		if (!this.mobileProgressNotice) {
			this.mobileProgressNotice = new Notice(message, 0);
		} else {
			this.mobileProgressNotice.setMessage(message);
		}
	}

	private hideMobileProgressNotice(): void {
		if (this.mobileProgressNotice) {
			this.mobileProgressNotice.hide();
			this.mobileProgressNotice = undefined;
		}
	}

	private isMobileClient(): boolean {
		return (
			(Platform as { isMobile?: boolean } | undefined)?.isMobile === true ||
			(this.app as { isMobile?: boolean }).isMobile === true
		);
	}

	/**
	 * DEV: Create a fake conflict for testing the conflict resolution UI.
	 */
	private async createTestConflict(): Promise<void> {
		if (!this.conflictQueue) {
			if (!this.eventManager) {
				this.eventManager = new EventManager(
					this.app,
					async () => {},
					this.syncStateManager,
					(path) =>
						shouldSyncVaultPath(
							path,
							this.settings.syncPluginManifests,
							false,
							this.app.vault.configDir,
							false
						)
				);
				this.eventManager.setPullOnlyModeCheck(() => this.getExperimentalSetting('pullOnlyMode'));
			}
			this.conflictQueue = new ConflictQueue(
				this.app,
				this.syncStateManager,
				this.eventManager,
				this.app.vault.configDir
			);
			this.conflictQueue.load(this.settings.conflictQueue);
		}

		const activeFile = this.app.workspace.getActiveFile?.();
		const file =
			activeFile instanceof TFile
				? activeFile
				: this.app.vault.getFiles().find((f: TFile) => f.extension === 'md');

		if (!file) {
			new Notice(t('notices.dev.noFileFound'));
			return;
		}

		const localContent = await this.app.vault.readBinary(file);
		const decoder = new TextDecoder('utf-8');
		const localText = decoder.decode(localContent);

		const fakeRemoteText =
			localText + '\n\n---\n_This line was added on another device (simulated incoming change)_\n';
		const fakeRemoteContent = new TextEncoder().encode(fakeRemoteText).buffer;

		await this.conflictQueue.add(
			file.path,
			localContent,
			fakeRemoteContent,
			file.stat.mtime,
			Date.now() - 60000,
			'fake-hash'
		);

		await this.saveSettings();
		this.updateConflictCount();
		await this.activateConflictView();

		new Notice(t('notices.dev.createdTestConflict', { path: file.path }));
	}

	/**
	 * Load settings from disk
	 */
	async loadSettings() {
		const loaded = ((await this.loadData()) as Partial<PluginSettings>) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	}

	/**
	 * Get an experimental setting with fallback to defaults.
	 */
	getExperimentalSetting<K extends keyof ExperimentalSettings>(key: K): ExperimentalSettings[K] {
		return this.settings.experimental?.[key] ?? DEFAULT_EXPERIMENTAL_SETTINGS[key];
	}

	/**
	 * Make sure this plugin's id is listed in `.obsidian/community-plugins.json`.
	 */
	private async ensureSelfInCommunityPluginsList(): Promise<void> {
		const id = this.manifest?.id;
		if (!id) {
			return;
		}

		const { adapter } = this.app.vault;
		if (!isCommunityPluginsAdapter(adapter)) {
			logger.warn('Vault adapter does not support community plugin self-healing');
			return;
		}

		await guardCommunityPluginsList(adapter, id, this.app.vault.configDir);
	}

	async onPluginManifestSyncChanged(enabled: boolean): Promise<void> {
		if (this.settings.syncPluginManifests === enabled) {
			return;
		}

		this.settings.syncPluginManifests = enabled;
		await this.saveSettings();
	}

	async onAppSettingsSyncChanged(enabled: boolean): Promise<void> {
		if (this.settings.syncAppSettings === enabled) {
			return;
		}

		this.settings.syncAppSettings = enabled;
		await this.saveSettings();
	}

	async onCssSnippetSyncChanged(enabled: boolean): Promise<void> {
		if (this.settings.syncCssSnippets === enabled) {
			return;
		}

		this.settings.syncCssSnippets = enabled;
		await this.saveSettings();
	}

	/**
	 * Clear tracked sync state (no delta cursor to reset with Koofr — this
	 * clears the FileState/folder-path cache so the next sync re-evaluates
	 * everything from a fresh remote snapshot).
	 */
	async resetSyncToken(): Promise<void> {
		this.syncStateManager.clearState();
		await this.saveSettings();
		new Notice(t('notices.sync.reset'));
	}

	/**
	 * Reconcile the local vault from a full cloud listing. Treats cloud as
	 * authoritative — local-only files are deleted, remote-only files are
	 * downloaded. Destructive deletes are confirmed via the large-delete modal.
	 */
	async reconcileFromCloud(): Promise<void> {
		if (!this.credentialStorage.hasCredentials()) {
			new Notice(t('notices.reconcile.notConnected'));
			return;
		}
		if (!this.isSyncConfigured()) {
			new Notice(t('notices.reconcile.selectFolderFirst'));
			return;
		}
		if (!this.syncEngine) {
			new Notice(t('notices.reconcile.engineNotInitialized'));
			return;
		}
		if (this.isSyncing || this.eventManager?.isSyncInProgress()) {
			new Notice(t('notices.reconcile.alreadyInProgress'));
			return;
		}
		this.isSyncing = true;
		try {
			this.setSyncStatus(SyncStatus.SYNCING);
			await this.syncEngine.reconcileFromCloud();
			await this.saveSettings();
			this.setSyncStatus(SyncStatus.IDLE);
		} catch (error) {
			this.setSyncStatus(SyncStatus.ERROR);
			throw error;
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Save settings to disk
	 */
	async saveSettings() {
		// Credentials are stored in SecretStorage, not in data.json

		this.settings.syncState = this.syncStateManager.prepareForSave();

		if (this.conflictQueue) {
			this.settings.conflictQueue = this.conflictQueue.prepareForSave();
		}

		if (this.conflictResolver) {
			this.conflictResolver.setStrategy(this.settings.conflictResolution);
		}

		if (this.eventManager) {
			this.eventManager.setSyncOnFileChange(this.settings.syncOnFileChange ?? true);
		}

		this.applyLogLevel();
		this.applyVaultLogHook();

		await this.saveData(this.settings);
	}

	private static readonly LOG_LEVEL_MAP: Record<string, LogLevel> = {
		off: LogLevel.OFF,
		error: LogLevel.ERROR,
		warn: LogLevel.WARN,
		info: LogLevel.INFO,
		debug: LogLevel.DEBUG,
	};

	private applyLogLevel(): void {
		const level = KoofrSyncPlugin.LOG_LEVEL_MAP[this.settings.logLevel] ?? LogLevel.OFF;
		logger.setLogLevel(level);
	}

	/**
	 * Install (or remove) a Logger hook that appends each log line to a
	 * vault-root daily log file.
	 */
	private applyVaultLogHook(): void {
		const { adapter } = this.app.vault;
		if (!isVaultLogAdapter(adapter)) {
			logger.setVaultLogHook(null);
			return;
		}

		applyPluginVaultLogHook({
			enabled: this.settings.logLevel !== 'off',
			adapter,
			setVaultLogHook: (hook) => {
				logger.setVaultLogHook(hook);
			},
		});
	}

	/**
	 * Show the large-delete warning modal and act on the user's choice.
	 */
	private handleLargeDeleteWarning(info: LargeDeleteWarningInfo): Promise<LargeDeleteDecision> {
		return new Promise((resolve) => {
			const modal = new LargeDeleteWarningModal(this.app, info, (decision) => {
				if (decision === 'disable') {
					timerApi.setTimeout(() => {
						try {
							const plugins = (
								this.app as unknown as {
									plugins?: { disablePlugin?: (id: string) => Promise<void> | void };
								}
							).plugins;
							if (plugins?.disablePlugin) {
								void plugins.disablePlugin(this.manifest.id);
							}
						} catch (err) {
							logger.error(
								`Failed to disable plugin from large-delete modal: ${(err as Error)?.message || err}`
							);
						}
					}, 0);
				}
				resolve(decision);
			});
			modal.open();
		});
	}
}
