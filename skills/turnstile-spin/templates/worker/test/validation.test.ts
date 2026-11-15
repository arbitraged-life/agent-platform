/**
 * tests/4 — Validation surface.
 *
 * Tests the endpoints that Turnstile Spin's wizard relies on during its
 * post-deploy validation step:
 *
 *   - GET /health           returns {ok: true, version}
 *   - GET /                 returns the same shape
 *   - POST / with dummy     returns a structured error (success: false, error-codes,
 *                           _worker metadata) rather than a bare 500
 *   - hostname mismatch     when EXPECTED_HOSTNAME is set
 *
 * These match the assertions in the wizard's Step 7. If any of these fail,
 * the wizard's validation step will fail, and the customer will see a
 * misleading "setup complete" message followed by a broken integration.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index.js';
import type { Env } from '../src/types.js';

const ENV: Env = {
	TURNSTILE_SECRET_KEY: 'test-secret-key',
	ALLOWED_ORIGIN: '*',
};

describe('validation surface — /health', () => {
	it('returns ok:true and a semver version', async () => {
		const res = await worker.fetch(new Request('https://w/health'), ENV);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; version: string };
		expect(body.ok).toBe(true);
		expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it('GET / returns the same shape as /health', async () => {
		const [a, b] = await Promise.all([
			worker.fetch(new Request('https://w/'), ENV),
			worker.fetch(new Request('https://w/health'), ENV),
		]);
		const ja = (await a.json()) as { ok: boolean; version: string };
		const jb = (await b.json()) as { ok: boolean; version: string };
		expect(ja.ok).toBe(jb.ok);
		expect(ja.version).toBe(jb.version);
	});

	it('responds in well under the wizard timeout (1s)', async () => {
		const start = Date.now();
		await worker.fetch(new Request('https://w/health'), ENV);
		expect(Date.now() - start).toBeLessThan(1000);
	});
});

describe('validation surface — dummy siteverify returns structured error', () => {
	beforeEach(() => vi.restoreAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it('returns success:false + error-codes + _worker for a dummy token', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
			return new Response(
				JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
				{ status: 200 },
			);
		});

		const res = await worker.fetch(
			new Request('https://w/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: 'XXXX.DUMMY.TOKEN.XXXX' }),
			}),
			ENV,
		);

		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			success: boolean;
			'error-codes': string[];
			_worker?: { duration_ms: number; worker_version: string };
		};

		// Wizard's required assertions:
		expect(body.success).toBe(false);
		expect(Array.isArray(body['error-codes'])).toBe(true);
		expect(body['error-codes'].length).toBeGreaterThan(0);
		expect(body._worker).toBeDefined();
		expect(typeof body._worker?.duration_ms).toBe('number');
		const health = await worker.fetch(new Request('https://w/health'), ENV);
		const healthBody = (await health.json()) as { version: string };
		expect(body._worker?.worker_version).toBe(healthBody.version);
	});

	it('returns structured error on Worker-level failure (no bare 500)', async () => {
		// Force the upstream to be unreachable.
		vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
			throw new TypeError('network unreachable');
		});
		// Disable the retry loop by also failing the second attempt.
		vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
			throw new TypeError('network unreachable');
		});

		const res = await worker.fetch(
			new Request('https://w/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: 'whatever' }),
			}),
			ENV,
		);

		// Worker-level failure still returns a *parseable* error body.
		const body = (await res.json()) as { success: boolean; 'error-codes': string[]; _worker?: unknown };
		expect(body.success).toBe(false);
		expect(body['error-codes'][0]).toBe('upstream-unreachable');
		expect(body._worker).toBeDefined();
	});
});

describe('upstream response transport', () => {
	afterEach(() => vi.restoreAllMocks());

	it('retries an interrupted successful response body', async () => {
		const interrupted = new ReadableStream({
			start(controller) {
				controller.error(new TypeError('response stream interrupted'));
			},
		});
		const upstream = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(interrupted, { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, 'error-codes': [] }), { status: 200 }));
		const response = await worker.fetch(new Request('https://w/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token: 'fixture-token' }),
		}), ENV);

		expect(response.status).toBe(200);
		expect((await response.json() as { success: boolean }).success).toBe(true);
		expect(upstream).toHaveBeenCalledTimes(2);
	});
});

describe('validation surface — hostname mismatch', () => {
	beforeEach(() => vi.restoreAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it('rejects success when EXPECTED_HOSTNAME does not match', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
			return new Response(
				JSON.stringify({ success: true, hostname: 'attacker.example.com', 'error-codes': [] }),
				{ status: 200 },
			);
		});

		const env: Env = { ...ENV, EXPECTED_HOSTNAME: 'www.example.com' };
		const res = await worker.fetch(
			new Request('https://w/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: 'abc' }),
			}),
			env,
		);

		const body = (await res.json()) as { success: boolean; 'error-codes': string[] };
		expect(body.success).toBe(false);
		expect(body['error-codes']).toContain('hostname-mismatch');
	});
});

describe('validation surface — telemetry marker passthrough', () => {
	beforeEach(() => vi.restoreAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it('passes data-action through to siteverify and surfaces it in the response', async () => {
		// Upstream echoes the action field. Spin marker should survive.
		vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
			return new Response(
				JSON.stringify({
					success: true,
					hostname: 'example.com',
					action: 'turnstile-spin-v1',
					'error-codes': [],
				}),
				{ status: 200 },
			);
		});

		const res = await worker.fetch(
			new Request('https://w/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: 'abc' }),
			}),
			ENV,
		);

		const body = (await res.json()) as { success: boolean; action?: string };
		expect(body.success).toBe(true);
		expect(body.action).toBe('turnstile-spin-v1');
	});
});

describe('validation surface — post-deploy form is reachable', () => {
	it('GET /post-deploy returns 404 when ASSETS binding is missing (test env)', async () => {
		// In the unit-test env we don't have the ASSETS binding wired, so the
		// handler falls through. The real Worker has the binding from wrangler.toml.
		const res = await worker.fetch(new Request('https://w/post-deploy'), ENV);
		expect(res.status).toBe(404);
	});

	it('GET /post-deploy serves the HTML file when ASSETS is bound', async () => {
		const html = '<!doctype html><title>Post-deploy</title>';
		const mockAssets: Fetcher = {
			fetch: async () =>
				new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
		} as unknown as Fetcher;

		const envWithAssets: Env = { ...ENV, ASSETS: mockAssets };
		const res = await worker.fetch(new Request('https://w/post-deploy'), envWithAssets);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('Post-deploy');
	});
});


describe('security regressions', () => {
	afterEach(() => vi.restoreAllMocks());

	it('rejects a missing hostname when an expected hostname is configured', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true })));
		const res = await worker.fetch(new Request('https://w/', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'fixture' }),
		}), { ...ENV, EXPECTED_HOSTNAME: 'example.com' });
		const body = await res.json() as { success: boolean; 'error-codes': string[] };
		expect(body.success).toBe(false);
		expect(body['error-codes']).toContain('hostname-mismatch');
	});

	it.each([400, 503])('cannot turn upstream HTTP %s into successful verification', async (status) => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ success: true }), { status }));
		const res = await worker.fetch(new Request('https://w/', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'fixture' }),
		}), ENV);
		expect(res.status).toBe(502);
		expect((await res.json() as { success: boolean }).success).toBe(false);
	});

	it('logs custom-data presence without its value', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, cdata: 'private-fixture-value' })));
		await worker.fetch(new Request('https://w/', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'fixture' }),
		}), ENV);
		expect(log).toHaveBeenCalled();
		const serialized = log.mock.calls.map(call => call.join(' ')).join('\n');
		expect(serialized).toContain('"cdata_present":true');
		expect(serialized).not.toContain('private-fixture-value');
		expect(serialized).not.toContain('cdata_value');
	});
});


describe('CORS configuration', () => {
	it('does not grant browser cross-origin access without an explicit origin', async () => {
		const response = await worker.fetch(new Request('https://w/health'), { TURNSTILE_SECRET_KEY: 'fixture' });
		expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
	});
	it('preserves an explicitly configured browser origin', async () => {
		const response = await worker.fetch(new Request('https://w/health'), { ...ENV, ALLOWED_ORIGIN: 'https://example.com' });
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
	});
});


describe('upstream response deadline', () => {
	afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
	it('bounds stalled response bodies across both attempts', async () => {
		vi.useFakeTimers();
		const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
			const stream = new ReadableStream({ start(controller) {
				init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Timed out', 'AbortError')));
			} });
			return new Response(stream, { status: 200 });
		});
		const pending = worker.fetch(new Request('https://w/', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'fixture' }),
		}), ENV);
		await vi.advanceTimersByTimeAsync(10001);
		const response = await pending;
		expect(response.status).toBe(504);
		expect(upstream).toHaveBeenCalledTimes(2);
	});
});

describe('upstream response schema', () => {
	afterEach(() => vi.restoreAllMocks());

	const post = (env: Env = ENV) => worker.fetch(new Request('https://w/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ token: 'private-token' }),
	}), env);

	it.each([
		['null', null],
		['array', [true]],
		['missing success', {}],
		['nonboolean success', { success: 'false', 'error-codes': ['private-upstream-value'] }],
		['invalid hostname', { success: true, hostname: 42 }],
		['invalid challenge timestamp', { success: true, challenge_ts: null }],
		['invalid action', { success: true, action: [] }],
		['invalid cdata', { success: true, cdata: { private: 'private-upstream-value' } }],
		['invalid error codes', { success: false, 'error-codes': [23] }],
	])('fails closed on %s in a successful HTTP response', async (_name, value) => {
		const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(value)));
		const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
		const response = await post();
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ success: false, 'error-codes': ['invalid-upstream-response'] });
		expect(upstream).toHaveBeenCalledOnce();
		const serialized = logs.mock.calls.flat().join('\n');
		expect(serialized).not.toContain('private-token');
		expect(serialized).not.toContain('private-upstream-value');
	});

	it('classifies malformed successful JSON as a terminal format error', async () => {
		const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{invalid-upstream-json'));
		const response = await post();
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ success: false, 'error-codes': ['invalid-upstream-response'] });
		expect(upstream).toHaveBeenCalledOnce();
	});

	it('accepts valid extensible error codes and normalizes absent error codes', async () => {
		const upstream = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify({
				success: false, 'error-codes': ['provider-new-code'], cdata: 'private-upstream-value',
			})))
			.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, action: 'signup', _worker: { worker_version: 'spoofed' } })));
		const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
		const rejected = await post();
		expect(rejected.status).toBe(200);
		expect(await rejected.json()).toMatchObject({ success: false, 'error-codes': ['provider-new-code'] });
		const accepted = await post();
		expect(accepted.status).toBe(200);
		const value = await accepted.json() as { success: boolean; action: string; 'error-codes': string[]; _worker: { worker_version: string } };
		expect(value.success).toBe(true);
		expect(value.action).toBe('signup');
		expect(value['error-codes']).toEqual([]);
		expect(value._worker.worker_version).not.toBe('spoofed');
		expect(upstream).toHaveBeenCalledTimes(2);
		expect(logs.mock.calls.flat().join('\n')).not.toContain('private-upstream-value');
	});

	it.each([400, 503])('sanitizes malformed known HTTP %s diagnostics without discarding unknown metadata', async status => {
		const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			new Response(JSON.stringify({
				success: true,
				'error-codes': ['provider-new-code'],
				hostname: 17,
				challenge_ts: null,
				action: ['invalid'],
				cdata: { invalid: true },
				ephemeral_id: 'provider-extra',
				_worker: { worker_version: 'spoofed' },
			}), { status }));
		const response = await post();
		expect(response.status).toBe(502);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toMatchObject({
			success: false, 'error-codes': ['provider-new-code'], ephemeral_id: 'provider-extra',
		});
		for (const field of ['hostname', 'challenge_ts', 'action', 'cdata']) {
			expect(body).not.toHaveProperty(field);
		}
		expect(body._worker).toMatchObject({ worker_version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
		expect(upstream).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
	});

	it.each([400, 503])('preserves valid known HTTP %s diagnostics and normalizes invalid error codes', async status => {
		const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			new Response(JSON.stringify({
				success: true,
				'error-codes': [7],
				hostname: 'example.com',
				challenge_ts: '2026-05-22T12:00:00Z',
				action: 'signup',
				cdata: 'private-marker',
				ephemeral_id: 'provider-extra',
			}), { status }));
		const response = await post();
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({
			success: false,
			'error-codes': ['bad-request'],
			hostname: 'example.com',
			challenge_ts: '2026-05-22T12:00:00Z',
			action: 'signup',
			cdata: 'private-marker',
			ephemeral_id: 'provider-extra',
		});
		expect(upstream).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
	});

	it.each([400, 503])('ignores misleading success and invalid diagnostics on HTTP %s', async status => {
		const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			new Response(JSON.stringify({ success: true, 'error-codes': [7], hostname: 'example.com' }), { status }));
		const response = await post();
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ success: false, 'error-codes': ['bad-request'] });
		expect(upstream).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
	});
});

describe('configured siteverify log levels', () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		['ok', { success: true }, 'info'],
		['fail', { success: false, 'error-codes': ['invalid-input-response'] }, 'warn'],
		['error', { success: 'invalid' }, 'error'],
	] as const)('filters %s outcome with every threshold', async (_outcome, upstreamBody, severity) => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(upstreamBody)));
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		for (const level of ['debug', 'info', 'warn', 'error'] as const) {
			log.mockClear();
			await worker.fetch(new Request('https://w/', {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'private-token' }),
			}), { ...ENV, LOG_LEVEL: level });
			const shouldLog = ['debug', 'info', 'warn', 'error'].indexOf(severity) >= ['debug', 'info', 'warn', 'error'].indexOf(level);
			expect(log.mock.calls).toHaveLength(shouldLog ? 1 : 0);
			if (shouldLog) {
				const entry = JSON.parse(String(log.mock.calls[0]?.[0])) as { level: string; event: string };
				expect(entry.level).toBe(severity);
				expect(entry.event).toBe('siteverify');
				expect(JSON.stringify(entry)).not.toContain('private-token');
			}
		}
	});

	it('keeps upstream HTTP failures visible at the error threshold', async () => {
		const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			new Response(JSON.stringify({
				success: false, 'error-codes': ['internal-error'], cdata: 'private-data',
			}), { status: 503 }));
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const response = await worker.fetch(new Request('https://w/', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token: 'private-token' }),
		}), { ...ENV, LOG_LEVEL: 'error' });
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ success: false });
		expect(upstream).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledOnce();
		const serialized = String(log.mock.calls[0]?.[0]);
		expect(JSON.parse(serialized)).toMatchObject({
			level: 'error', outcome: 'error', upstream_status: 503, error_codes: ['internal-error'],
		});
		expect(serialized).not.toContain('private-token');
		expect(serialized).not.toContain('private-data');
	});

	it('defaults invalid and missing runtime settings to info', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			new Response(JSON.stringify({ success: true, cdata: 'private-data' })));
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		for (const setting of [undefined, 'unexpected'] as const) {
			log.mockClear();
			await worker.fetch(new Request('https://w/', {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'private-token' }),
			}), { ...ENV, LOG_LEVEL: setting as Env['LOG_LEVEL'] });
			expect(log).toHaveBeenCalledOnce();
			const serialized = String(log.mock.calls[0]?.[0]);
			expect(serialized).toContain('"level":"info"');
			expect(serialized).toContain('"cdata_present":true');
			expect(serialized).not.toContain('private-token');
			expect(serialized).not.toContain('private-data');
		}
	});

	it('filters both parse-error callsites and validation-error callsites', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const env = { ...ENV, LOG_LEVEL: 'error' as const };
		const request = (contentType: string, body: string) => worker.fetch(new Request('https://w/', {
			method: 'POST', headers: { 'Content-Type': contentType }, body,
		}), env);
		await request('text/plain', 'token=abc');
		await request('application/json', '{invalid');
		await request('application/json', '{}');
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
		await request('application/json', '{"token":"abc"}');
		expect(log.mock.calls).toHaveLength(4);
		expect(log.mock.calls.every(call => JSON.parse(String(call[0])).level === 'error')).toBe(true);
	});
});
