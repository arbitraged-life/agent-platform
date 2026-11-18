/**
 * Calls Cloudflare's siteverify endpoint. One retry on transient (5xx + network)
 * failures, with a tight timeout. Validates upstream JSON before returning
 * it with Worker metadata.
 */

import { SiteverifyError } from './errors.js';
import type { Env, SiteverifyRequest, SiteverifyResponse } from './types.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const UPSTREAM_TIMEOUT_MS = 5000;
const RETRY_ON_STATUSES = new Set([500, 502, 503, 504]);

export interface ValidateResult {
	response: SiteverifyResponse;
	upstreamStatus: number;
	durationMs: number;
}

function parseSiteverifyResponse(value: unknown): SiteverifyResponse {
	const invalid = () => new SiteverifyError(502, 'invalid-upstream-response', 'Invalid Siteverify response');
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
	const data = value as Record<string, unknown>;
	const success = data.success;
	if (typeof success !== 'boolean') throw invalid();
	for (const field of ['challenge_ts', 'hostname', 'action', 'cdata']) {
		if (data[field] !== undefined && typeof data[field] !== 'string') throw invalid();
	}
	const errorCodes = data['error-codes'];
	if (errorCodes !== undefined && (!Array.isArray(errorCodes) || !errorCodes.every(code => typeof code === 'string'))) {
		throw invalid();
	}
	const codes: string[] = errorCodes === undefined ? [] : errorCodes as string[];
	return { ...data, success, 'error-codes': codes };
}

/**
 * Validate a Turnstile token against Cloudflare's siteverify endpoint.
 *
 * @throws SiteverifyError on Worker-level failures (missing secret, unreachable upstream, timeout)
 */
export async function validate(req: SiteverifyRequest, env: Env, workerVersion: string): Promise<ValidateResult> {
	if (!env.TURNSTILE_SECRET_KEY) {
		throw new SiteverifyError(500, 'missing-input-secret', 'TURNSTILE_SECRET_KEY not configured');
	}
	if (!req.token) {
		throw new SiteverifyError(400, 'missing-token', 'token is required');
	}

	const body = new FormData();
	body.append('secret', env.TURNSTILE_SECRET_KEY);
	body.append('response', req.token);
	if (req.remoteip) body.append('remoteip', req.remoteip);
	if (req.idempotency_key) body.append('idempotency_key', req.idempotency_key);

	const start = Date.now();
	let lastErr: unknown = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const result = await fetchWithTimeout(SITEVERIFY_URL, body, UPSTREAM_TIMEOUT_MS);
			const durationMs = Date.now() - start;
			if (result.status >= 200 && result.status < 300) {
				const data = parseSiteverifyResponse(result.data);
				data._worker = {
					duration_ms: durationMs,
					worker_version: workerVersion,
				};
				// Hostname-mismatch defense. If the customer set EXPECTED_HOSTNAME,
				// reject responses whose hostname doesn't match — defends against
				// cross-site token replay even if a token leaks.
				if (data.success && env.EXPECTED_HOSTNAME && data.hostname !== env.EXPECTED_HOSTNAME) {
					const rejected: SiteverifyResponse = {
						...data,
						success: false,
						'error-codes': ['hostname-mismatch'],
					};
					return { response: rejected, upstreamStatus: result.status, durationMs };
				}
				return { response: data, upstreamStatus: result.status, durationMs };
			}
			if (!RETRY_ON_STATUSES.has(result.status) || attempt === 1) {
				// Preserve object diagnostics, but never accept an HTTP error as success.
				const data = result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data)
					? result.data as Record<string, unknown>
					: {};
				const errorCodes = data['error-codes'];
				const response: SiteverifyResponse = {
					...data,
					success: false,
					'error-codes': Array.isArray(errorCodes) && errorCodes.every(code => typeof code === 'string')
						? errorCodes
						: ['bad-request'],
					_worker: { duration_ms: durationMs, worker_version: workerVersion },
				};
				// HTTP-error diagnostics may be partial or malformed. Retain extensible
				// provider metadata, but do not expose known fields with invalid types.
				for (const field of ['challenge_ts', 'hostname', 'action', 'cdata'] as const) {
					if (response[field] !== undefined && typeof response[field] !== 'string') {
						delete response[field];
					}
				}
				return { response, upstreamStatus: result.status, durationMs };
			}
			// 5xx + first attempt: retry
		} catch (err) {
			if (err instanceof SiteverifyError && err.code === 'invalid-upstream-response') throw err;
			lastErr = err;
			if (attempt === 1) break;
		}
	}

	if (lastErr instanceof DOMException && lastErr.name === 'AbortError') {
		throw new SiteverifyError(504, 'upstream-timeout', `Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`);
	}
	throw new SiteverifyError(502, 'upstream-unreachable', `Upstream siteverify unreachable: ${String(lastErr)}`);
}

async function fetchWithTimeout(url: string, body: FormData, timeoutMs: number): Promise<{ status: number; data: unknown }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: 'POST',
			body,
			signal: controller.signal,
		});
		const data = await response.json().catch((error: unknown) => {
			if (controller.signal.aborted) throw error;
			if (response.ok) {
				if (error instanceof SyntaxError) throw new SiteverifyError(502, 'invalid-upstream-response', 'Invalid Siteverify response');
				throw error;
			}
			return {};
		});
		return { status: response.status, data };
	} finally {
		clearTimeout(timer);
	}
}
