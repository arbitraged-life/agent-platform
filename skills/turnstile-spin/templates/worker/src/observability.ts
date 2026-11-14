/**
 * Structured logging helpers. Output is JSON-per-line so Workers Observability
 * + log-shipping pipelines can parse + index without regex hacks.
 */

import type { Env, SiteverifyLogEntry } from './types.js';

export interface LogContext {
	durationMs: number;
	upstreamStatus?: number;
	errorCodes?: string[];
	cdataValue?: string;
	remoteipPresent: boolean;
	idempotencyKeyPresent: boolean;
}

const SEVERITY = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export function logSiteverify(outcome: 'ok' | 'fail' | 'error', ctx: LogContext, minimumLevel: Env['LOG_LEVEL'] = 'info'): void {
	const level = outcome === 'ok' ? 'info' : outcome === 'fail' ? 'warn' : 'error';
	const threshold = minimumLevel === 'debug' || minimumLevel === 'warn' || minimumLevel === 'error'
		? minimumLevel
		: 'info';
	if (SEVERITY[level] < SEVERITY[threshold]) return;
	const entry: SiteverifyLogEntry = {
		level,
		event: 'siteverify',
		outcome,
		duration_ms: ctx.durationMs,
		upstream_status: ctx.upstreamStatus,
		error_codes: ctx.errorCodes ?? [],
		cdata_present: typeof ctx.cdataValue === 'string' && ctx.cdataValue.length > 0,
		remoteip_present: ctx.remoteipPresent,
		idempotency_key_present: ctx.idempotencyKeyPresent,
		ts: new Date().toISOString(),
	};
	// console.log goes to Workers logs and Observability.
	// Using a JSON line for machine-readability.
	console.log(JSON.stringify(entry));
}
