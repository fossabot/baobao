import { createWorkspace, type IPackageInfo, type MonorepoWorkspace } from '@build-script/monorepo-lib';
import { AsyncDisposable, Emitter, isWindows, PathArray } from '@idlebox/common';
import { logger, type IMyLogger } from '@idlebox/logger';
import { getEnvironment } from '@idlebox/node';
import { CompileError, ModeKind, ProcessIPCClient, WorkersManager } from '@mpis/server';
import { RigConfig, type IRigConfig } from '@rushstack/rig-package';
import { dirname, resolve } from 'node:path';
import { split as splitCmd } from 'split-cmd';
import { currentCommand } from '../bin.js';

export async function createMonorepoObject() {
	const workspace = await createWorkspace();
	const repo = new PnpmMonoRepo(logger, workspace);
	await repo.initialize();
	return repo;
}

export type IPnpmMonoRepo = PnpmMonoRepo;

class PnpmMonoRepo extends AsyncDisposable {
	private readonly workersManager: WorkersManager;
	private readonly pathvar: PathArray;
	private readonly errorMessages = new Map<IPackageInfo, string>();
	private readonly rigConfig = new Map<IPackageInfo, IRigConfig>(); // TODO: 太重了

	private readonly _onStateChange = this._register(new Emitter<void>());
	public readonly onStateChange = this._onStateChange.event;

	private readonly mode: ModeKind;

	constructor(
		public readonly logger: IMyLogger,
		protected readonly workspace: MonorepoWorkspace,
	) {
		super('PnpmMonoRepo');

		const pathVar = getEnvironment(isWindows ? 'Path' : 'PATH').value;
		if (!pathVar) {
			throw new Error('PATH environment variable is not set');
		}
		this.pathvar = new PathArray(pathVar);
		this.pathvar.add(dirname(process.execPath), true, true);

		this.mode = currentCommand === 'watch' ? ModeKind.Watch : ModeKind.Build;
		this.workersManager = new WorkersManager(this.mode, logger);
		this.workersManager._register(this);
	}

	async initialize() {
		await this.workspace.decoupleDependencies();
		const projects = await this.workspace.listPackages();
		for (const project of projects) {
			if (!project.packageJson.name) continue;

			const exec = this.makeExecuter(this.mode === ModeKind.Watch, project);
			if (exec) {
				this.workersManager.addWorker(exec, project.devDependencies);
			} else {
				this.workersManager.addEmptyWorker(project.packageJson.name);
			}
		}
	}

	async _finalize() {
		this.workersManager.finalize();
	}

	async startup() {
		this.workersManager.finalize();
		// this.dump();
		await this.workersManager.startup();
	}

	private makeExecuter(watchMode: boolean, project: IPackageInfo): undefined | ProcessIPCClient {
		if (project.packageJson.scripts?.watch === undefined) {
			this.logger
				.fatal`project ${project.packageJson.name} does not have a "watch" script. If it doesn't need, specify a empty string.`;
		}
		if (project.packageJson.scripts?.build === undefined) {
			this.logger
				.fatal`project ${project.packageJson.name} does not have a "build" script. If it doesn't need, specify a empty string.`;
		}
		const script = watchMode ? project.packageJson.scripts.watch : project.packageJson.scripts.build;

		if (script === '') {
			this.logger.verbose`skip project "${project.packageJson.name}" with a empty script.`;
			return undefined;
		}

		const cmds = splitCmd(script);
		if (!cmds.length) {
			this.logger.fatal`project ${project.packageJson.name} script "${script}" is invalid.`;
		}
		const logger = this.logger.extend(project.name);

		const env: Record<string, string> = {};
		env[isWindows ? 'Path' : 'PATH'] = this.forkPath(project).toString();

		const exec = new ProcessIPCClient(project.packageJson.name, cmds, project.absolute, env, logger); // TODO: env add Path
		exec.displayTitle = cmds[0];

		exec.onFailure((e) => {
			if (e instanceof CompileError) {
				this.errorMessages.set(project, e.message + '\n' + (e.output ?? 'no output from process'));
			} else {
				this.errorMessages.set(project, e.stack || e.message);
			}
			this._onStateChange.fireNoError();
		});
		exec.onSuccess(() => {
			this.errorMessages.delete(project);
			this._onStateChange.fireNoError();
		});
		exec.onStart(() => {
			this.errorMessages.delete(project);
			this._onStateChange.fireNoError();
		});
		exec.onTerminate(() => {
			this._onStateChange.fireNoError();
		});
		return exec;
	}

	formatErrors() {
		if (this.errorMessages.size === 0) return '';
		let output = '';

		const flush_line = ' '.repeat(process.stderr.columns || 80);
		for (const [project, text] of this.errorMessages.entries()) {
			output += `\n\x1B[48;5;1m${flush_line}\r    \x1B[0;38;5;9;1m  below is output of ${project.packageJson.name}  \x1B[0m\n`;
			output += text;
			output += `\x1B[48;5;1m${flush_line}\r    \x1B[0;38;5;9;1m  ending output of ${project.packageJson.name}  \x1B[0m\n`;
		}
		return output;
	}

	private getRig(project: IPackageInfo) {
		const exists = this.rigConfig.get(project);
		if (exists) {
			return exists;
		}

		const rig = RigConfig.loadForProjectFolder({ projectFolderPath: project.absolute });
		this.rigConfig.set(project, rig);
		return rig;
	}

	private forkPath(info: IPackageInfo) {
		const pathvar = this.pathvar.clone();

		const rig = this.getRig(info);
		if (rig.rigFound) {
			const rig_nm = resolve(rig.getResolvedProfileFolder(), '../../node_modules/.bin');
			pathvar.add(rig_nm, true, true);
			this.logger.debug`[path:rig] using rig bindir: long<${rig_nm}>`;
		} else {
			this.logger.debug`[path:rig] using rig bindir: no`;
		}

		pathvar.add(resolve(info.absolute, 'node_modules/.bin'), true, true);

		return pathvar;
	}

	dump(depth: number = 0) {
		if (depth <= 0) {
			return this.workersManager.formatDebugList();
		} else {
			return this.workersManager.formatDebugGraph(depth);
		}
	}

	printScreen() {
		let r = this.formatErrors();
		r += this.dump();
		console.error(r);
	}
}
