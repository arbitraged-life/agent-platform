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
import worker, { WORKER_VERSION } from '../src/index.js';
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
		expect(body.version).toBe(WORKER_VERSION);
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
		expect(body._worker?.worker_version).toBe(WORKER_VERSION);
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
