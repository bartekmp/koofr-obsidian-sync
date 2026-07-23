/**
 * Modal for picking a Koofr mount and browsing its folders
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import { KoofrFileInfo, KoofrMount } from '../types';
import { RootFolderWarningModal } from './modals';
import { t } from '../i18n';

export interface FolderSelection {
	path: string;
	name: string;
	mountId: string;
	mountName: string;
}

type FolderListFn = (mountId: string, path: string) => Promise<KoofrFileInfo[]>;
type FolderCreateFn = (mountId: string, parentPath: string, name: string) => Promise<void>;

export interface FolderBrowserOptions {
	/** Show a confirmation warning when the mount root is selected (default: false) */
	warnOnRootSelect?: boolean;
}

/**
 * Modal that lets the user pick a Koofr mount, then browse, create, and
 * select a folder within it.
 */
export class FolderBrowserModal extends Modal {
	private mounts: KoofrMount[];
	private selectedMount?: KoofrMount;
	private currentPath: string[] = [];
	private onSelect: (selection: FolderSelection) => void;
	private listFolders: FolderListFn;
	private createFolder: FolderCreateFn;
	private contentEl_body: HTMLElement;
	private loading = false;
	private warnOnRootSelect: boolean;
	private newFolderName = '';
	private creatingFolder = false;

	constructor(
		app: App,
		mounts: KoofrMount[],
		listFolders: FolderListFn,
		createFolder: FolderCreateFn,
		onSelect: (selection: FolderSelection) => void,
		initialMountId?: string,
		initialPath?: string,
		options?: FolderBrowserOptions
	) {
		super(app);
		this.mounts = mounts;
		this.listFolders = listFolders;
		this.createFolder = createFolder;
		this.onSelect = onSelect;
		this.warnOnRootSelect = options?.warnOnRootSelect ?? false;

		if (initialMountId) {
			this.selectedMount = mounts.find((m) => m.id === initialMountId);
		}
		if (initialPath) {
			this.currentPath = initialPath.split('/').filter((s) => s.length > 0);
		}
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('koofr-folder-browser');

		contentEl.createEl('h3', { text: t('folderBrowser.title') });

		this.contentEl_body = contentEl.createDiv({
			cls: 'folder-browser-body koofr-sync-folder-browser-body',
		});

		if (this.selectedMount) {
			void this.loadFolder();
		} else {
			this.renderMountList();
		}
	}

	onClose() {
		this.contentEl.empty();
	}

	private renderMountList(): void {
		const body = this.contentEl_body;
		body.empty();

		body.createDiv({
			text: t('folderBrowser.selectMount'),
			cls: 'koofr-sync-folder-browser-note',
		});

		if (this.mounts.length === 0) {
			body.createDiv({
				text: t('folderBrowser.noMounts'),
				cls: 'koofr-sync-folder-browser-note koofr-sync-folder-browser-empty',
			});
			return;
		}

		for (const mount of this.mounts) {
			const row = body.createDiv({ cls: 'folder-row koofr-sync-folder-row' });
			const icon = mount.isShared ? '🔗' : '📦';
			const label = mount.isPrimary
				? t('folderBrowser.primaryMount', { name: mount.name })
				: mount.name;
			row.createSpan({ text: `${icon} ${label}` });
			row.onclick = () => {
				this.selectedMount = mount;
				this.currentPath = [];
				void this.loadFolder();
			};
		}
	}

	private get currentPathStr(): string {
		return this.currentPath.length > 0 ? `/${this.currentPath.join('/')}` : '/';
	}

	private async loadFolder() {
		if (this.loading || !this.selectedMount) return;
		this.loading = true;
		const mount = this.selectedMount;

		const body = this.contentEl_body;
		body.empty();

		// Breadcrumb
		const breadcrumb = body.createDiv({
			cls: 'folder-breadcrumb koofr-sync-folder-breadcrumb',
		});

		if (this.mounts.length > 1) {
			const backLink = breadcrumb.createSpan({
				text: `← ${t('folderBrowser.changeMount')}`,
				cls: 'koofr-sync-folder-breadcrumb-link',
			});
			backLink.onclick = () => {
				this.selectedMount = undefined;
				this.currentPath = [];
				this.renderMountList();
			};
			breadcrumb.createSpan({ text: '  ' });
		}

		const rootLink = breadcrumb.createSpan({
			text: `📦 ${mount.name}`,
			cls: 'koofr-sync-folder-breadcrumb-link',
		});
		rootLink.onclick = () => {
			this.currentPath = [];
			void this.loadFolder();
		};

		for (let i = 0; i < this.currentPath.length; i++) {
			breadcrumb.createSpan({ text: ' / ' });
			const seg = breadcrumb.createSpan({ text: this.currentPath[i] });
			if (i < this.currentPath.length - 1) {
				seg.addClass('koofr-sync-folder-breadcrumb-link');
				const depth = i;
				seg.onclick = () => {
					this.currentPath = this.currentPath.slice(0, depth + 1);
					void this.loadFolder();
				};
			}
		}

		// Select button for the current folder. This is also shown at the mount
		// root (empty path) so the user can sync the entire mount if desired.
		// The folder picked here becomes the sync destination itself — files
		// land directly inside it, nothing is auto-created under it.
		{
			const isRoot = this.currentPath.length === 0;
			const selectRow = body.createDiv({ cls: 'koofr-sync-folder-browser-select-row' });
			new Setting(selectRow)
				.setName(
					isRoot
						? t('folderBrowser.selectRoot', { label: mount.name })
						: t('folderBrowser.selectCurrent', { path: this.currentPath.join('/') })
				)
				.setDesc(t('folderBrowser.selectDestinationDesc'))
				.addButton((btn) =>
					btn
						.setButtonText(t('folderBrowser.useThisFolder'))
						.setCta()
						.onClick(() => {
							const commit = () => {
								this.onSelect({
									path: this.currentPathStr,
									name: isRoot ? mount.name : this.currentPath[this.currentPath.length - 1],
									mountId: mount.id,
									mountName: mount.name,
								});
								this.close();
							};

							// Syncing the whole mount is a footgun — confirm first
							// when the caller opted in.
							if (isRoot && this.warnOnRootSelect) {
								new RootFolderWarningModal(this.app, commit).open();
							} else {
								commit();
							}
						})
				);
		}

		// Create a new subfolder under the current location, then jump into it.
		{
			const createRow = body.createDiv({ cls: 'koofr-sync-folder-browser-create-row' });
			let textComponentRef: { getValue(): string } | undefined;
			new Setting(createRow)
				.setName(t('folderBrowser.createFolder.name'))
				.addText((text) => {
					textComponentRef = text;
					text.setPlaceholder(t('folderBrowser.createFolder.placeholder')).onChange((value) => {
						this.newFolderName = value;
					});
				})
				.addButton((btn) =>
					btn
						.setButtonText(t('folderBrowser.createFolder.button'))
						.setDisabled(this.creatingFolder)
						.onClick(() => {
							void (async () => {
								const name = (textComponentRef?.getValue() ?? this.newFolderName).trim();
								if (!name) return;
								this.creatingFolder = true;
								try {
									await this.createFolder(mount.id, this.currentPathStr, name);
									this.currentPath.push(name);
									this.newFolderName = '';
								} catch (error) {
									new Notice(
										t('folderBrowser.createFolder.failed', {
											message:
												error instanceof Error ? error.message : t('folderBrowser.unknownError'),
										})
									);
								} finally {
									this.creatingFolder = false;
								}
								void this.loadFolder();
							})();
						})
				);
		}

		// Loading indicator
		const loadingEl = body.createDiv({
			text: t('folderBrowser.loading'),
			cls: 'koofr-sync-folder-browser-note',
		});

		try {
			const items = await this.listFolders(mount.id, this.currentPathStr);
			const folders = items.filter((item) => item.type === 'dir');

			loadingEl.remove();

			if (folders.length === 0) {
				body.createDiv({
					text: t('folderBrowser.noSubfolders'),
					cls: 'koofr-sync-folder-browser-note koofr-sync-folder-browser-empty',
				});
			}

			for (const folder of folders) {
				const row = body.createDiv({
					cls: 'folder-row koofr-sync-folder-row',
				});
				row.createSpan({ text: `📁 ${folder.name}` });

				row.onclick = () => {
					this.currentPath.push(folder.name);
					void this.loadFolder();
				};
			}
		} catch (error) {
			loadingEl.remove();
			body.createDiv({
				text: t('folderBrowser.loadError', {
					message: error instanceof Error ? error.message : t('folderBrowser.unknownError'),
				}),
				cls: 'koofr-sync-folder-browser-error',
			});
		}

		this.loading = false;
	}
}
