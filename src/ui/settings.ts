/**
 * Settings tab for the Koofr Sync plugin
 */

import { App, PluginSettingTab, Setting, Notice, type PluginManifest } from 'obsidian';
import {
	PluginSettings,
	ConflictResolutionStrategy,
	KoofrFileInfo,
	KoofrMount,
	ExperimentalSettings,
	DEFAULT_EXPERIMENTAL_SETTINGS,
} from '../types';
import { KOOFR_APP_PASSWORD_URL, SYNC_INTERVAL_OPTIONS } from '../constants';
import { FolderBrowserModal, FolderSelection } from './folderBrowserModal';
import type { SyncStatusInfo } from '../main';
import { SyncStatus } from './statusBar';
import { t } from '../i18n';

// Forward declaration for the plugin type
interface KoofrPlugin {
	settings: PluginSettings;
	manifest: PluginManifest;
	saveSettings(): Promise<void>;
	onAppSettingsSyncChanged(enabled: boolean): Promise<void>;
	onPluginManifestSyncChanged(enabled: boolean): Promise<void>;
	onCssSnippetSyncChanged(enabled: boolean): Promise<void>;
	resetSyncToken(): Promise<void>;
	reconcileFromCloud(): Promise<void>;
	authenticate(email: string, appPassword: string): Promise<void>;
	disconnect(): void;
	triggerManualSync(): Promise<void>;
	listMounts(): Promise<KoofrMount[]>;
	listFoldersForPicker(mountId: string, path: string): Promise<KoofrFileInfo[]>;
	createFolderForPicker(mountId: string, parentPath: string, name: string): Promise<void>;
	onRemoteFolderChanged(selection: FolderSelection): Promise<void>;
	getSyncStatusInfo(): SyncStatusInfo;
	getExperimentalSetting<K extends keyof ExperimentalSettings>(key: K): ExperimentalSettings[K];
}

/**
 * Settings tab UI
 */
export class KoofrSettingTab extends PluginSettingTab {
	plugin: KoofrPlugin;
	private pendingEmail = '';
	private pendingAppPassword = '';

	constructor(app: App, plugin: KoofrPlugin) {
		super(app, plugin as never);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.displayAuthSection(containerEl);
		this.displaySyncFolderSection(containerEl);
		this.displaySyncSection(containerEl);
		this.displayAdvancedSection(containerEl);
		this.displayExperimentalSection(containerEl);
	}

	/**
	 * Display authentication section
	 */
	private displayAuthSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t('settings.auth.heading')).setHeading();

		const isConnected = !!this.plugin.settings.connectedEmail;

		const statusSetting = new Setting(containerEl).setName(
			t('settings.auth.connectionStatus.name')
		);

		if (isConnected) {
			statusSetting.setDesc(
				t('settings.auth.connectionStatus.connectedAs', {
					email: this.plugin.settings.connectedEmail || '',
				})
			);
			statusSetting.addButton((button) =>
				button.setButtonText(t('settings.auth.connectionStatus.disconnect')).onClick(async () => {
					this.plugin.disconnect();
					this.display();
				})
			);
			return;
		}

		statusSetting.setDesc(t('settings.auth.connectionStatus.notConnected'));

		const helpDiv = containerEl.createDiv({
			cls: 'setting-item-description koofr-sync-settings-help',
		});
		helpDiv.appendText(t('settings.auth.appPasswordHelpPrefix'));
		helpDiv.createEl('a', {
			text: t('settings.auth.appPasswordHelpLink'),
			href: KOOFR_APP_PASSWORD_URL,
			attr: { target: '_blank' },
		});
		helpDiv.appendText(t('settings.auth.appPasswordHelpSuffix'));

		new Setting(containerEl).setName(t('settings.auth.email.name')).addText((text) =>
			text
				.setPlaceholder(t('settings.auth.email.placeholder'))
				.setValue(this.pendingEmail)
				.onChange((value) => {
					this.pendingEmail = value.trim();
				})
		);

		new Setting(containerEl).setName(t('settings.auth.appPassword.name')).addText((text) => {
			text.inputEl.type = 'password';
			text
				.setPlaceholder(t('settings.auth.appPassword.placeholder'))
				.setValue(this.pendingAppPassword)
				.onChange((value) => {
					this.pendingAppPassword = value;
				});
		});

		new Setting(containerEl).addButton((button) =>
			button
				.setButtonText(t('settings.auth.connectionStatus.connect'))
				.setCta()
				.onClick(async () => {
					if (!this.pendingEmail || !this.pendingAppPassword) {
						new Notice(t('settings.auth.connectionStatus.missingFields'));
						return;
					}
					try {
						await this.plugin.authenticate(this.pendingEmail, this.pendingAppPassword);
						this.pendingAppPassword = '';
						this.display();
					} catch (error) {
						new Notice(
							t('settings.auth.connectionStatus.connectFailed', {
								message:
									error instanceof Error
										? error.message
										: t('settings.auth.connectionStatus.unknownError'),
							})
						);
					}
				})
		);
	}

	/**
	 * Display sync folder (mount + path) section
	 */
	private displaySyncFolderSection(containerEl: HTMLElement): void {
		const isConnected = !!this.plugin.settings.connectedEmail;

		new Setting(containerEl).setName(t('settings.syncFolder.heading')).setHeading();
		containerEl.createEl('p', {
			text: t('settings.syncFolder.explainer'),
			cls: 'setting-item-description koofr-sync-settings-help',
		});

		if (isConnected) {
			const mountName = this.plugin.settings.mountName || t('settings.syncFolder.notSelected');
			const path = this.plugin.settings.remotePath || '/';
			const desc = this.plugin.settings.mountId
				? t('settings.syncFolder.currentSelection', { mount: mountName, path })
				: t('settings.syncFolder.notSelected');

			new Setting(containerEl)
				.setName(t('settings.syncFolder.remoteFolder'))
				.setDesc(desc)
				.addButton((btn) =>
					btn.setButtonText(t('settings.syncFolder.browse')).onClick(async () => {
						const mounts = await this.plugin.listMounts().catch((error) => {
							new Notice(
								t('settings.syncFolder.listMountsFailed', {
									message: error instanceof Error ? error.message : String(error),
								})
							);
							return [] as KoofrMount[];
						});
						const modal = new FolderBrowserModal(
							this.app,
							mounts,
							(mountId, path) => this.plugin.listFoldersForPicker(mountId, path),
							(mountId, parentPath, name) =>
								this.plugin.createFolderForPicker(mountId, parentPath, name),
							(selection: FolderSelection) => {
								void this.plugin.onRemoteFolderChanged(selection).then(() => {
									this.display();
								});
							},
							this.plugin.settings.mountId,
							this.plugin.settings.remotePath,
							{ warnOnRootSelect: true }
						);
						modal.open();
					})
				);

			this.displaySyncStatus(containerEl);
		} else {
			new Setting(containerEl)
				.setName(t('settings.syncFolder.remoteFolder'))
				.setDesc(t('settings.syncFolder.connectFirst'));
		}
	}

	/**
	 * Display sync configuration section
	 */
	private displaySyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t('settings.sync.heading')).setHeading();

		const { configDir } = this.app.vault;

		// Sync interval — a plain dropdown over SYNC_INTERVAL_OPTIONS. (A
		// slider was tried here and dropped: Obsidian's Setting control
		// column is sized for compact controls, not a multi-stop labeled
		// slider with tick marks, and it never rendered cleanly.)
		const closestIntervalIndex = (minutes: number): number => {
			let bestIndex = 0;
			let bestDiff = Infinity;
			SYNC_INTERVAL_OPTIONS.forEach((opt, i) => {
				const diff = Math.abs(opt.minutes - minutes);
				if (diff < bestDiff) {
					bestDiff = diff;
					bestIndex = i;
				}
			});
			return bestIndex;
		};

		new Setting(containerEl)
			.setName(t('settings.sync.automaticInterval.name'))
			.setDesc(t('settings.sync.automaticInterval.desc'))
			.addDropdown((dropdown) => {
				SYNC_INTERVAL_OPTIONS.forEach((opt, i) => {
					dropdown.addOption(String(i), opt.label);
				});
				dropdown
					.setValue(String(closestIntervalIndex(this.plugin.settings.syncInterval)))
					.onChange(async (value) => {
						this.plugin.settings.syncInterval = SYNC_INTERVAL_OPTIONS[Number(value)].minutes;
						await this.plugin.saveSettings();
					});
			});

		// Sync on file change toggle
		new Setting(containerEl)
			.setName(t('settings.sync.onFileChange.name'))
			.setDesc(t('settings.sync.onFileChange.desc'))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnFileChange ?? true).onChange(async (value) => {
					this.plugin.settings.syncOnFileChange = value;
					await this.plugin.saveSettings();
				})
			);

		// Startup sync delay
		new Setting(containerEl)
			.setName(t('settings.sync.startupDelay.name'))
			.setDesc(t('settings.sync.startupDelay.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('0', t('settings.sync.startupDelay.disabled'))
					.addOption('1', t('settings.sync.startupDelay.oneSecond'))
					.addOption('10', t('settings.sync.startupDelay.tenSeconds'))
					.addOption('30', t('settings.sync.startupDelay.thirtySeconds'))
					.setValue(String(this.plugin.settings.startupSyncDelay))
					.onChange(async (value) => {
						this.plugin.settings.startupSyncDelay = parseInt(value);
						await this.plugin.saveSettings();
					})
			);

		// Conflict resolution strategy
		new Setting(containerEl)
			.setName(t('settings.sync.conflictResolution.name'))
			.setDesc(t('settings.sync.conflictResolution.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						ConflictResolutionStrategy.LAST_WRITE_WINS,
						t('settings.sync.conflictResolution.lastWriteWins')
					)
					.addOption(
						ConflictResolutionStrategy.CREATE_DUPLICATE,
						t('settings.sync.conflictResolution.createDuplicate')
					)
					.addOption(
						ConflictResolutionStrategy.MANUAL,
						t('settings.sync.conflictResolution.manual')
					)
					.setValue(this.plugin.settings.conflictResolution)
					.onChange(async (value) => {
						this.plugin.settings.conflictResolution = value as ConflictResolutionStrategy;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('settings.sync.appSettings.name'))
			.setDesc(t('settings.sync.appSettings.desc', { configDir }))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncAppSettings).onChange(async (value) => {
					await this.plugin.onAppSettingsSyncChanged(value);
				})
			);

		new Setting(containerEl)
			.setName(t('settings.sync.plugins.name'))
			.setDesc(t('settings.sync.plugins.desc', { configDir }))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncPluginManifests).onChange(async (value) => {
					await this.plugin.onPluginManifestSyncChanged(value);
				})
			);

		new Setting(containerEl)
			.setName(t('settings.sync.cssSnippets.name'))
			.setDesc(t('settings.sync.cssSnippets.desc', { configDir }))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncCssSnippets).onChange(async (value) => {
					await this.plugin.onCssSnippetSyncChanged(value);
				})
			);
	}

	private displaySyncStatus(containerEl: HTMLElement): void {
		const isConnected = !!this.plugin.settings.connectedEmail;
		const syncStatus = this.plugin.getSyncStatusInfo();
		const statusText = this.getSyncStatusText(syncStatus.status);
		const lastSyncText = syncStatus.lastSyncTime
			? new Date(syncStatus.lastSyncTime).toLocaleString()
			: t('settings.sync.status.notSyncedYet');
		const progressText =
			syncStatus.status === SyncStatus.SYNCING
				? syncStatus.progressMessage || t('settings.sync.status.starting')
				: t('settings.sync.status.noProgress');
		const conflictText =
			syncStatus.conflictCount > 0
				? t('settings.sync.status.conflictsPending', { count: syncStatus.conflictCount })
				: t('settings.sync.status.noConflicts');

		new Setting(containerEl)
			.setName(t('settings.sync.status.name'))
			.setDesc(
				t('settings.sync.status.desc', {
					status: statusText,
					lastSync: lastSyncText,
					progress: progressText,
					conflicts: conflictText,
				})
			)
			.addButton((btn) => {
				btn
					.setButtonText(t('settings.sync.status.syncNow'))
					.setCta()
					.onClick(() => {
						void this.plugin.triggerManualSync();
					});
				if (!isConnected || !this.plugin.settings.mountId) {
					btn.setDisabled(true);
					btn.setTooltip(
						!isConnected
							? t('settings.sync.status.connectTooltip')
							: t('settings.sync.status.selectFolderTooltip')
					);
				}
			});
	}

	/**
	 * Display advanced section
	 */
	private displayAdvancedSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t('settings.advanced.heading')).setHeading();

		// Log level
		new Setting(containerEl)
			.setName(t('settings.advanced.logLevel.name'))
			.setDesc(t('settings.advanced.logLevel.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('off', t('settings.advanced.logLevel.off'))
					.addOption('error', t('settings.advanced.logLevel.error'))
					.addOption('warn', t('settings.advanced.logLevel.warn'))
					.addOption('info', t('settings.advanced.logLevel.info'))
					.addOption('debug', t('settings.advanced.logLevel.debug'))
					.setValue(this.plugin.settings.logLevel)
					.onChange(async (value) => {
						this.plugin.settings.logLevel = value as PluginSettings['logLevel'];
						await this.plugin.saveSettings();
					})
			);

		// Large-delete safety threshold
		new Setting(containerEl)
			.setName(t('settings.advanced.largeDeleteThreshold.name'))
			.setDesc(t('settings.advanced.largeDeleteThreshold.desc'))
			.addText((text) =>
				text
					.setPlaceholder(t('settings.advanced.largeDeleteThreshold.placeholder'))
					.setValue(String(this.plugin.settings.largeDeleteThreshold ?? 25))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (Number.isNaN(parsed) || parsed < 0) return;
						this.plugin.settings.largeDeleteThreshold = parsed;
						await this.plugin.saveSettings();
					})
			);

		// Reset sync token (clears tracked state; no delta cursor to reset with Koofr)
		new Setting(containerEl)
			.setName(t('settings.advanced.resetSyncToken.name'))
			.setDesc(t('settings.advanced.resetSyncToken.desc'))
			.addButton((button) =>
				button.setButtonText(t('settings.advanced.resetSyncToken.button')).onClick(async () => {
					await this.plugin.resetSyncToken();
				})
			);

		// Reconcile from cloud (cloud-as-truth recovery)
		new Setting(containerEl)
			.setName(t('settings.advanced.reconcileFromCloud.name'))
			.setDesc(t('settings.advanced.reconcileFromCloud.desc'))
			.addButton((button) =>
				button.setButtonText(t('settings.advanced.reconcileFromCloud.button')).onClick(async () => {
					await this.plugin.reconcileFromCloud();
				})
			);
	}

	private getSyncStatusText(status: SyncStatus): string {
		switch (status) {
			case SyncStatus.SYNCING:
				return t('settings.sync.status.syncing');
			case SyncStatus.IDLE:
				return t('settings.sync.status.idle');
			case SyncStatus.ERROR:
				return t('settings.sync.status.error');
			case SyncStatus.DISCONNECTED:
				return t('settings.sync.status.disconnected');
			default:
				return status;
		}
	}

	/**
	 * Display experimental settings section
	 */
	private displayExperimentalSection(containerEl: HTMLElement): void {
		const detailsEl = containerEl.createEl('details', { cls: 'koofr-experimental-section' });
		const summaryEl = detailsEl.createEl('summary');
		new Setting(summaryEl).setName(t('settings.experimental.heading')).setHeading();

		new Setting(detailsEl).setDesc(t('settings.experimental.description'));

		// Max concurrent operations
		new Setting(detailsEl)
			.setName(t('settings.experimental.maxConcurrentOperations.name'))
			.setDesc(t('settings.experimental.maxConcurrentOperations.desc'))
			.addText((text) =>
				text
					.setPlaceholder(t('settings.experimental.maxConcurrentOperations.placeholder'))
					.setValue(String(this.plugin.getExperimentalSetting('maxConcurrentOperations')))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (Number.isNaN(parsed) || parsed < 1 || parsed > 16) return;
						this.plugin.settings.experimental = {
							...DEFAULT_EXPERIMENTAL_SETTINGS,
							...this.plugin.settings.experimental,
							maxConcurrentOperations: parsed,
						};
						await this.plugin.saveSettings();
					})
			);

		// Pull-only mode
		new Setting(detailsEl)
			.setName(t('settings.experimental.pullOnlyMode.name'))
			.setDesc(t('settings.experimental.pullOnlyMode.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.getExperimentalSetting('pullOnlyMode'))
					.onChange(async (value) => {
						this.plugin.settings.experimental = {
							...DEFAULT_EXPERIMENTAL_SETTINGS,
							...this.plugin.settings.experimental,
							pullOnlyMode: value,
						};
						await this.plugin.saveSettings();
					})
			);
	}
}
