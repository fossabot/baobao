import { createLogger, type IMyLogger } from '@idlebox/logger';
import { execLazyError, findUpUntil } from '@idlebox/node';
import { dirname, resolve } from 'node:path';
import { decoupleDependencies } from './common/deduplicate-dependency.js';
import { PackageManagerKind, WorkspaceKind, type IPackageInfo, type IPackageInfoRW } from './common/types.js';
import { lernaListProjects, nxListProjects } from './drivers/lerna-nx.js';
import { npmListProjects } from './drivers/npm.js';
import { pnpmListProjects } from './drivers/pnpm.js';
import { rushListProjects } from './drivers/rush.js';
import { yarnListProjects } from './drivers/yarn.js';

interface IAnalyzeResult {
	readonly root: string;
	readonly packageManagerKind: PackageManagerKind;
	readonly workspaceKind: WorkspaceKind;
	readonly temp: string;
}

export class MonorepoWorkspace implements IAnalyzeResult {
	public readonly root: string;
	public readonly packageManagerKind: PackageManagerKind;
	public readonly workspaceKind: WorkspaceKind;

	/**
	 * 临时文件夹，保证在project目录内部
	 */
	public readonly temp: string;

	constructor(
		result: IAnalyzeResult,
		protected readonly logger: IMyLogger = createLogger('workspace'),
	) {
		if (result.packageManagerKind === PackageManagerKind.Unknown) {
			throw new Error('packageManagerKind cannot be Unknown');
		}
		if (result.workspaceKind === WorkspaceKind.Unknown) {
			throw new Error('workspaceKind cannot be Unknown');
		}

		this.root = result.root;
		this.packageManagerKind = result.packageManagerKind;
		this.workspaceKind = result.workspaceKind;
		this.temp = result.temp;
	}

	public async requireGitClean() {
		const res = await execLazyError('git', ['status', '--porcelain'], { cwd: this.root });
		if (res.stdout.trim().length > 0) {
			throw new Error(`请先提交或清理工作区的修改`);
		}
	}

	/**
	 *
	 * @param from 搜索起始目录
	 * @returns
	 */
	public async getNearestPackage(from: string) {
		const pkgJsonFile = await findUpUntil({ from, top: this.root, file: 'package.json' });
		if (!pkgJsonFile) {
			throw new Error(`缺少package.json文件: ${from}`);
		}
		return dirname(pkgJsonFile);
	}

	public getNpmRCPath(publish = false) {
		const name = publish ? '.npmrc-publish' : '.npmrc';
		if (this.workspaceKind === WorkspaceKind.RushStack) {
			return resolve(this.root, 'common/config/rush', name);
		} else {
			return resolve(this.root, name);
		}
	}

	public async listPackages(): Promise<IPackageInfo[]> {
		await this.initialize();
		return Array.from(this.cachedList.values());
	}

	public async getPackage(name: string): Promise<IPackageInfo | undefined> {
		await this.initialize();
		return this.cachedList.get(name);
	}

	private readonly cachedList = new Map<string, IPackageInfoRW>();
	private async initialize() {
		if (this.cachedList.size > 0) {
			return;
		}

		const list = await getWorkspaceList(this.root, this.workspaceKind);
		for (const pkg of list) {
			this.cachedList.set(pkg.name, pkg);
		}
	}

	private decoupled = false;
	async decoupleDependencies(method?: IDecoupleMethod) {
		if (this.decoupled) return;

		await this.initialize();
		const list = Array.from(this.cachedList.values());

		if (method) {
			method(list);
		} else {
			decoupleDependencies(this.logger, list);
		}

		this.decoupled = true;
	}
}

export type IDecoupleMethod = (projects: readonly IPackageInfoRW[]) => Promise<void>;

function getWorkspaceList(root: string, workspaceKind: WorkspaceKind): Promise<IPackageInfoRW[]> {
	switch (workspaceKind) {
		case WorkspaceKind.PnpmWorkspace:
			return pnpmListProjects(root);
		case WorkspaceKind.RushStack:
			return rushListProjects(root);
		case WorkspaceKind.Lerna:
			return lernaListProjects(root);
		case WorkspaceKind.NxJs:
			return nxListProjects(root);
		case WorkspaceKind.NpmWorkspace:
			return npmListProjects(root);
		case WorkspaceKind.YarnWorkspace:
			return yarnListProjects(root);
		default:
			throw new Error('Impossible');
	}
}
