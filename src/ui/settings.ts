/**
 * Settings tab for the Koofr Sync plugin
 */

import {
	App,
	PluginSettingTab,
	Notice,
	type PluginManifest,
	type ButtonComponent,
	type SettingDefinition,
	type SettingDefinitionItem,
} from 'obsidian';
import {
	PluginSettings,
	ConflictResolutionStrategy,
	KoofrFileInfo,
	KoofrMount,
	ExperimentalSettings,
	DEFAULT_EXPERIMENTAL_SETTINGS,
} from '../types';
import { KOOFR_APP_PASSWORD_URL, SYNC_INTERVAL_OPTIONS, SYNC_IGNORE_FILE } from '../constants';
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
	reconcileToCloud(): Promise<void>;
	authenticate(email: string, appPassword: string): Promise<void>;
	testConnection(): Promise<void>;
	disconnect(): void;
	triggerManualSync(): Promise<void>;
	readSyncIgnore(): Promise<string>;
	writeSyncIgnore(content: string): Promise<void>;
	listMounts(): Promise<KoofrMount[]>;
	listFoldersForPicker(mountId: string, path: string): Promise<KoofrFileInfo[]>;
	createFolderForPicker(mountId: string, parentPath: string, name: string): Promise<void>;
	onRemoteFolderChanged(selection: FolderSelection): Promise<void>;
	getSyncStatusInfo(): SyncStatusInfo;
	getExperimentalSetting<K extends keyof ExperimentalSettings>(key: K): ExperimentalSettings[K];
}

/**
 * Keys passed to getControlValue/setControlValue by declarative controls.
 * They are virtual: some map onto differently-shaped settings (e.g. the
 * sync interval is stored in minutes but picked by index).
 */
type ControlKey =
	| 'syncInterval'
	| 'syncOnFileChange'
	| 'syncOnChangeDelay'
	| 'startupSyncDelay'
	| 'conflictResolution'
	| 'syncAppSettings'
	| 'syncPluginManifests'
	| 'syncCssSnippets'
	| 'logLevel'
	| 'largeDeleteThreshold'
	| 'maxConcurrentOperations'
	| 'pullOnlyMode';

const CHANGE_DELAY_SECONDS = [3, 5, 10, 30, 60];

/** Description made of several lines (plain strings don't render line breaks). */
function descLines(...lines: string[]): DocumentFragment {
	return createFragment((frag) => {
		lines.forEach((line, i) => {
			if (i > 0) frag.createEl('br');
			frag.appendText(line);
		});
	});
}

/**
 * Settings tab UI (declarative — requires Obsidian 1.13.0+)
 */
export class KoofrSettingTab extends PluginSettingTab {
	plugin: KoofrPlugin;
	private pendingEmail = '';
	private pendingAppPassword = '';

	constructor(app: App, plugin: KoofrPlugin) {
		super(app, plugin as never);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.authGroup(),
			this.syncFolderGroup(),
			this.syncGroup(),
			this.advancedGroup(),
			this.experimentalPage(),
		];
	}

	// ------------------------------------------------------------------
	// Control value storage
	// ------------------------------------------------------------------

	getControlValue(key: string): unknown {
		const settings = this.plugin.settings;
		switch (key as ControlKey) {
			case 'syncInterval':
				return String(this.closestIntervalIndex(settings.syncInterval));
			case 'syncOnFileChange':
				return settings.syncOnFileChange ?? true;
			case 'syncOnChangeDelay':
				return String(settings.syncOnChangeDelay);
			case 'startupSyncDelay':
				return String(settings.startupSyncDelay);
			case 'conflictResolution':
				return settings.conflictResolution;
			case 'syncAppSettings':
				return settings.syncAppSettings;
			case 'syncPluginManifests':
				return settings.syncPluginManifests;
			case 'syncCssSnippets':
				return settings.syncCssSnippets;
			case 'logLevel':
				return settings.logLevel;
			case 'largeDeleteThreshold':
				return settings.largeDeleteThreshold ?? 25;
			case 'maxConcurrentOperations':
				return this.plugin.getExperimentalSetting('maxConcurrentOperations');
			case 'pullOnlyMode':
				return this.plugin.getExperimentalSetting('pullOnlyMode');
			default:
				return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key as ControlKey) {
			case 'syncInterval':
				settings.syncInterval = SYNC_INTERVAL_OPTIONS[Number(value)].minutes;
				break;
			case 'syncOnFileChange':
				settings.syncOnFileChange = value as boolean;
				break;
			case 'syncOnChangeDelay':
				settings.syncOnChangeDelay = parseInt(value as string, 10);
				break;
			case 'startupSyncDelay':
				settings.startupSyncDelay = parseInt(value as string, 10);
				break;
			case 'conflictResolution':
				settings.conflictResolution = value as ConflictResolutionStrategy;
				break;
			case 'syncAppSettings':
				// These three have side effects (file tracking), so the plugin saves
				await this.plugin.onAppSettingsSyncChanged(value as boolean);
				return;
			case 'syncPluginManifests':
				await this.plugin.onPluginManifestSyncChanged(value as boolean);
				return;
			case 'syncCssSnippets':
				await this.plugin.onCssSnippetSyncChanged(value as boolean);
				return;
			case 'logLevel':
				settings.logLevel = value as PluginSettings['logLevel'];
				break;
			case 'largeDeleteThreshold':
				settings.largeDeleteThreshold = value as number;
				break;
			case 'maxConcurrentOperations':
				settings.experimental = {
					...DEFAULT_EXPERIMENTAL_SETTINGS,
					...settings.experimental,
					maxConcurrentOperations: value as number,
				};
				break;
			case 'pullOnlyMode':
				settings.experimental = {
					...DEFAULT_EXPERIMENTAL_SETTINGS,
					...settings.experimental,
					pullOnlyMode: value as boolean,
				};
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
	}

	// ------------------------------------------------------------------
	// Authentication
	// ------------------------------------------------------------------

	private authGroup(): SettingDefinitionItem {
		const connectedEmail = this.plugin.settings.connectedEmail;
		const heading = t('settings.auth.heading');

		if (connectedEmail) {
			return {
				type: 'group',
				heading,
				items: [
					{
						name: t('settings.auth.connectionStatus.name'),
						desc: t('settings.auth.connectionStatus.connectedAs', { email: connectedEmail }),
						render: (setting) => {
							setting.addButton((button) =>
								button.setButtonText(t('settings.auth.connectionStatus.test')).onClick(() => {
									void this.runConnectionTest(button);
								})
							);
							setting.addButton((button) =>
								button.setButtonText(t('settings.auth.connectionStatus.disconnect')).onClick(() => {
									this.plugin.disconnect();
									this.update();
								})
							);
						},
					},
				],
			};
		}

		return {
			type: 'group',
			heading,
			items: [
				{
					name: t('settings.auth.connectionStatus.name'),
					desc: createFragment((frag) => {
						frag.appendText(t('settings.auth.connectionStatus.notConnected'));
						frag.createEl('br');
						frag.appendText(t('settings.auth.appPasswordHelpPrefix'));
						frag.createEl('a', {
							text: t('settings.auth.appPasswordHelpLink'),
							href: KOOFR_APP_PASSWORD_URL,
							attr: { target: '_blank' },
						});
						frag.appendText(t('settings.auth.appPasswordHelpSuffix'));
					}),
					render: () => {},
				},
				{
					name: t('settings.auth.email.name'),
					render: (setting) => {
						setting.addText((text) =>
							text
								.setPlaceholder(t('settings.auth.email.placeholder'))
								.setValue(this.pendingEmail)
								.onChange((value) => {
									this.pendingEmail = value.trim();
								})
						);
					},
				},
				{
					name: t('settings.auth.appPassword.name'),
					render: (setting) => {
						setting.addText((text) => {
							text.inputEl.type = 'password';
							text
								.setPlaceholder(t('settings.auth.appPassword.placeholder'))
								.setValue(this.pendingAppPassword)
								.onChange((value) => {
									this.pendingAppPassword = value;
								});
						});
					},
				},
				{
					name: t('settings.auth.connectionStatus.connect'),
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText(t('settings.auth.connectionStatus.connect'))
								.setCta()
								.onClick(() => {
									void this.connect();
								})
						);
					},
				},
			],
		};
	}

	private async runConnectionTest(button: ButtonComponent): Promise<void> {
		const original = button.buttonEl.textContent;
		button.setDisabled(true);
		button.setButtonText(t('settings.auth.connectionStatus.testing'));
		try {
			await this.plugin.testConnection();
			new Notice(t('settings.auth.connectionStatus.testSuccess'));
		} catch (error) {
			new Notice(
				t('settings.auth.connectionStatus.testFailed', {
					message: this.errorMessage(error),
				})
			);
		} finally {
			button.setDisabled(false);
			button.setButtonText(original ?? t('settings.auth.connectionStatus.test'));
		}
	}

	private async connect(): Promise<void> {
		if (!this.pendingEmail || !this.pendingAppPassword) {
			new Notice(t('settings.auth.connectionStatus.missingFields'));
			return;
		}
		try {
			await this.plugin.authenticate(this.pendingEmail, this.pendingAppPassword);
			this.pendingAppPassword = '';
			this.update();
		} catch (error) {
			new Notice(
				t('settings.auth.connectionStatus.connectFailed', { message: this.errorMessage(error) })
			);
		}
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error
			? error.message
			: t('settings.auth.connectionStatus.unknownError');
	}

	// ------------------------------------------------------------------
	// Sync folder
	// ------------------------------------------------------------------

	private syncFolderGroup(): SettingDefinitionItem {
		const explainer = t('settings.syncFolder.explainer');
		const isConnected = !!this.plugin.settings.connectedEmail;

		if (!isConnected) {
			return {
				type: 'group',
				heading: t('settings.syncFolder.heading'),
				items: [
					{
						name: t('settings.syncFolder.remoteFolder'),
						desc: descLines(explainer, t('settings.syncFolder.connectFirst')),
						render: () => {},
					},
				],
			};
		}

		const mountName = this.plugin.settings.mountName || t('settings.syncFolder.notSelected');
		const path = this.plugin.settings.remotePath || '/';
		const selection = this.plugin.settings.mountId
			? t('settings.syncFolder.currentSelection', { mount: mountName, path })
			: t('settings.syncFolder.notSelected');

		return {
			type: 'group',
			heading: t('settings.syncFolder.heading'),
			items: [
				{
					name: t('settings.syncFolder.remoteFolder'),
					desc: descLines(explainer, selection),
					render: (setting) => {
						setting.addButton((btn) =>
							btn.setButtonText(t('settings.syncFolder.browse')).onClick(() => {
								void this.browseRemoteFolder();
							})
						);
					},
				},
				this.syncStatusItem(),
			],
		};
	}

	private async browseRemoteFolder(): Promise<void> {
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
			(mountId, parentPath, name) => this.plugin.createFolderForPicker(mountId, parentPath, name),
			(selection: FolderSelection) => {
				void this.plugin.onRemoteFolderChanged(selection).then(() => {
					this.update();
				});
			},
			this.plugin.settings.mountId,
			this.plugin.settings.remotePath,
			{ warnOnRootSelect: true }
		);
		modal.open();
	}

	private syncStatusItem(): SettingDefinition {
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
		const hasFolder = !!this.plugin.settings.mountId;

		return {
			name: t('settings.sync.status.name'),
			desc: t('settings.sync.status.desc', {
				status: statusText,
				lastSync: lastSyncText,
				progress: progressText,
				conflicts: conflictText,
			}),
			render: (setting) => {
				setting.addButton((btn) => {
					btn
						.setButtonText(t('settings.sync.status.syncNow'))
						.setCta()
						.onClick(() => {
							void this.plugin.triggerManualSync();
						});
					if (!hasFolder) {
						btn.setDisabled(true);
						btn.setTooltip(t('settings.sync.status.selectFolderTooltip'));
					}
				});
			},
		};
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

	// ------------------------------------------------------------------
	// Sync configuration
	// ------------------------------------------------------------------

	private closestIntervalIndex(minutes: number): number {
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
	}

	private syncGroup(): SettingDefinitionItem {
		const { configDir } = this.app.vault;

		const intervalOptions: Record<string, string> = {};
		SYNC_INTERVAL_OPTIONS.forEach((opt, i) => {
			intervalOptions[String(i)] = opt.label;
		});

		const changeDelayOptions: Record<string, string> = {};
		for (const seconds of CHANGE_DELAY_SECONDS) {
			changeDelayOptions[String(seconds)] = t('settings.sync.changeDelay.seconds', { seconds });
		}

		return {
			type: 'group',
			heading: t('settings.sync.heading'),
			items: [
				{
					name: t('settings.sync.automaticInterval.name'),
					desc: t('settings.sync.automaticInterval.desc'),
					control: { type: 'dropdown', key: 'syncInterval', options: intervalOptions },
				},
				{
					name: t('settings.sync.onFileChange.name'),
					desc: t('settings.sync.onFileChange.desc'),
					control: { type: 'toggle', key: 'syncOnFileChange' },
				},
				{
					name: t('settings.sync.changeDelay.name'),
					desc: t('settings.sync.changeDelay.desc'),
					control: { type: 'dropdown', key: 'syncOnChangeDelay', options: changeDelayOptions },
				},
				{
					name: t('settings.sync.startupDelay.name'),
					desc: t('settings.sync.startupDelay.desc'),
					control: {
						type: 'dropdown',
						key: 'startupSyncDelay',
						options: {
							'0': t('settings.sync.startupDelay.disabled'),
							'1': t('settings.sync.startupDelay.oneSecond'),
							'10': t('settings.sync.startupDelay.tenSeconds'),
							'30': t('settings.sync.startupDelay.thirtySeconds'),
						},
					},
				},
				{
					name: t('settings.sync.conflictResolution.name'),
					desc: t('settings.sync.conflictResolution.desc'),
					control: {
						type: 'dropdown',
						key: 'conflictResolution',
						options: {
							[ConflictResolutionStrategy.LAST_WRITE_WINS]: t(
								'settings.sync.conflictResolution.lastWriteWins'
							),
							[ConflictResolutionStrategy.CREATE_DUPLICATE]: t(
								'settings.sync.conflictResolution.createDuplicate'
							),
							[ConflictResolutionStrategy.MANUAL]: t('settings.sync.conflictResolution.manual'),
						},
					},
				},
				{
					name: t('settings.sync.appSettings.name'),
					desc: t('settings.sync.appSettings.desc', { configDir }),
					control: { type: 'toggle', key: 'syncAppSettings' },
				},
				{
					name: t('settings.sync.plugins.name'),
					desc: t('settings.sync.plugins.desc', { configDir }),
					control: { type: 'toggle', key: 'syncPluginManifests' },
				},
				{
					name: t('settings.sync.cssSnippets.name'),
					desc: t('settings.sync.cssSnippets.desc', { configDir }),
					control: { type: 'toggle', key: 'syncCssSnippets' },
				},
				this.excludePatternsItem(),
			],
		};
	}

	/**
	 * Excluded patterns — a plain editor over the vault-root .syncIgnore file.
	 * The sync engine re-reads that file on every run, so writing it here is
	 * all that's needed. Rendered imperatively (not as a `textarea` control)
	 * so it is saved on blur instead of on every keystroke.
	 */
	private excludePatternsItem(): SettingDefinition {
		return {
			name: t('settings.sync.excludePatterns.name'),
			desc: descLines(
				t('settings.sync.excludePatterns.desc'),
				t('settings.sync.excludePatterns.fileHint', { file: SYNC_IGNORE_FILE })
			),
			render: (setting) => {
				setting.addTextArea((textArea) => {
					textArea.setPlaceholder(t('settings.sync.excludePatterns.placeholder'));
					textArea.inputEl.rows = 5;
					textArea.inputEl.addClass('koofr-sync-exclude-patterns');

					let loaded = '';
					void this.plugin.readSyncIgnore().then((content) => {
						loaded = content;
						textArea.setValue(content);
					});

					textArea.inputEl.addEventListener('blur', () => {
						const value = textArea.getValue();
						if (value === loaded) return;
						void this.plugin.writeSyncIgnore(value).then(
							() => {
								loaded = value;
								new Notice(t('settings.sync.excludePatterns.saved'));
							},
							(error: unknown) => {
								new Notice(
									t('settings.sync.excludePatterns.saveFailed', {
										message: error instanceof Error ? error.message : String(error),
									})
								);
							}
						);
					});
				});
			},
		};
	}

	// ------------------------------------------------------------------
	// Advanced
	// ------------------------------------------------------------------

	private advancedGroup(): SettingDefinitionItem {
		return {
			type: 'group',
			heading: t('settings.advanced.heading'),
			items: [
				{
					name: t('settings.advanced.logLevel.name'),
					desc: t('settings.advanced.logLevel.desc'),
					control: {
						type: 'dropdown',
						key: 'logLevel',
						options: {
							off: t('settings.advanced.logLevel.off'),
							error: t('settings.advanced.logLevel.error'),
							warn: t('settings.advanced.logLevel.warn'),
							info: t('settings.advanced.logLevel.info'),
							debug: t('settings.advanced.logLevel.debug'),
						},
					},
				},
				{
					name: t('settings.advanced.largeDeleteThreshold.name'),
					desc: t('settings.advanced.largeDeleteThreshold.desc'),
					control: {
						type: 'number',
						key: 'largeDeleteThreshold',
						min: 0,
						placeholder: t('settings.advanced.largeDeleteThreshold.placeholder'),
					},
				},
				this.actionButtonItem('resetSyncToken', () => this.plugin.resetSyncToken(), false),
				this.actionButtonItem('reconcileFromCloud', () => this.plugin.reconcileFromCloud(), true),
				this.actionButtonItem('reconcileToCloud', () => this.plugin.reconcileToCloud(), true),
			],
		};
	}

	private actionButtonItem(
		key: 'resetSyncToken' | 'reconcileFromCloud' | 'reconcileToCloud',
		run: () => Promise<void>,
		destructive: boolean
	): SettingDefinition {
		return {
			name: t(`settings.advanced.${key}.name`),
			desc: t(`settings.advanced.${key}.desc`),
			render: (setting) => {
				setting.addButton((button) => {
					button.setButtonText(t(`settings.advanced.${key}.button`));
					if (destructive) button.setDestructive();
					button.onClick(() => {
						void run();
					});
				});
			},
		};
	}

	// ------------------------------------------------------------------
	// Experimental
	// ------------------------------------------------------------------

	private experimentalPage(): SettingDefinitionItem {
		return {
			type: 'page',
			name: t('settings.experimental.heading'),
			desc: t('settings.experimental.description'),
			items: [
				{
					type: 'group',
					items: [
						{
							name: t('settings.experimental.maxConcurrentOperations.name'),
							desc: t('settings.experimental.maxConcurrentOperations.desc'),
							control: {
								type: 'number',
								key: 'maxConcurrentOperations',
								min: 1,
								max: 16,
								placeholder: t('settings.experimental.maxConcurrentOperations.placeholder'),
							},
						},
						{
							name: t('settings.experimental.pullOnlyMode.name'),
							desc: t('settings.experimental.pullOnlyMode.desc'),
							control: { type: 'toggle', key: 'pullOnlyMode' },
						},
					],
				},
			],
		};
	}
}
