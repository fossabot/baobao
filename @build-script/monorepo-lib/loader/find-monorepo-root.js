#!/usr/bin/env node

if (!process.execArgv.some((e) => e.startsWith('--inspect')) && !process.execArgv.includes('--enable-source-maps')) {
	const { install } = await import('source-map-support');
	install();
}

await import('../lib/bins/find-monorepo-root.js');
