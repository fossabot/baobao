import { prettyPrintError } from '@idlebox/common';
import { logger } from '@idlebox/logger';
import { execLazyError, exists } from '@idlebox/node';
import { resolve } from 'node:path';
import { isVerbose } from '../functions/cli.js';
import { PackageManager, type IUploadResult } from './driver.abstract.js';

interface IPnpmPublishResult {
	id: string;
	name: string;
	version: string;
	size: number;
	unpackedSize: number;
	shasum: string; // 'e320229fe019545b8e384ff19961de18d83c2673';
	integrity: string; // 'sha512-0HwCZquIeAlDPVBfb9FEpvD+fzRaw+t7+K9L4cUKFi0l2NbClu/YnmBt9rJy/pdkkfcnuB1CS7lBfsUN6AwVCA==';
	filename: string; // 'idlebox-common-1.4.2.tgz';
	files: {
		path: string;
		size: number;
		mode: number;
	}[];
	entryCount: number;
	bundled: []; // ?
}

type RegistryErrorField = {
	code: string;
	summary: string;
	detail: string;
};
class RegistryError extends Error {
	constructor(private readonly error: RegistryErrorField) {
		super(error.summary || 'no error summary');

		if (this.error.detail) {
			this.stack = this.error.detail;
		}
	}

	get code() {
		return this.error.code;
	}
}

const duplicatePublishRegex = /You cannot publish over the previously published versions: (.+)/;
const duplicatePublishOnUnpublishRegex = /Cannot publish over previously published version "(.+)"/;

export class PNPM extends PackageManager {
	override binary = 'pnpm';

	override async _pack(saveAs: string) {
		const chProcess = await execLazyError(this.binary, ['pack', '--out', saveAs], {
			cwd: this.projectPath,
			verbose: isVerbose,
			env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
		});
		const lastLine = chProcess.stdout.trim().split('\n').pop();
		if (!lastLine) {
			throw new Error('impossible: string split empty?');
		}
		const output = resolve(this.projectPath, lastLine);

		if (await exists(output)) {
			return output;
		}

		throw new Error(`pnpm pack失败: ${output} 不存在`);
	}

	override async _uploadTarball(pack: string, cwd: string): Promise<IUploadResult> {
		let result: IPnpmPublishResult;
		const cmds = ['publish', pack, '--json', '--no-git-checks'];
		const { stdout, all } = await this._execGetOut(cwd, cmds, false);
		try {
			const out = JSON.parse(stdout);
			if (out.error) {
				throw new RegistryError(out.error);
			} else {
				result = out;
				if (!result.name || !result.version) {
					logger.fatal`npm registry return invalid response:\n long<${stdout}>`;
				}
			}
		} catch (e: any) {
			if (e instanceof RegistryError) {
				let dupVer: string | undefined;
				dupVer = duplicatePublishRegex.exec(e.message)?.[1];
				if (!dupVer) {
					dupVer = duplicatePublishOnUnpublishRegex.exec(e.message)?.[1];
				}
				if (dupVer) {
					return {
						published: false,
						name: '', // TODO
						version: dupVer,
					};
				}
			}

			logger.warn`publish long<${pack}> error: ${e}`;
			console.error(all);
			prettyPrintError(`${this.binary} ${cmds.join(' ')}`, e);

			throw e;
		}

		return {
			published: true,
			name: result.name,
			version: result.version,
		};
	}
}
