---
name: turnstile-spin
description: Integrate Cloudflare Turnstile into web applications with explicit client/server boundaries, secret-safe validation, framework-appropriate rendering, and no floating deployment or destructive helper behavior.
---

# Turnstile Integration

Use when adding or repairing Cloudflare Turnstile challenge validation in a web application.

## Trust boundary

Treat the site key as public client configuration and the secret key as server-only credential material.

Never:
- print or return the secret key;
- write the secret into generated client code;
- commit it to source control;
- copy raw secret-bearing provider responses into logs;
- use a helper that fetches and prints secrets for convenience.

Use the application's existing secret-management mechanism or the deployment platform's secret store.

## Current provider behavior

When exact widget options, test keys, API fields, hostname behavior, or framework support matters, consult current Cloudflare Turnstile documentation. Do not rely on copied historical provider templates as authoritative product documentation.

## Client integration

1. Identify the rendering mode and framework already used by the application.
2. Load the Turnstile client integration through the framework's normal safe mechanism.
3. Render the widget only where the challenge is needed.
4. Pass the resulting token to the application's server with the protected request.
5. Handle expiration, retry, and user-visible failure without exposing implementation secrets.

Avoid adding a framework-specific wrapper package when the existing application can integrate the provider directly with comparable maintainability.
## Server validation

The server must validate the client token with Cloudflare before accepting the protected action.

Verification should:
- happen server-side;
- use bounded request timeouts;
- treat transport errors and malformed responses as verification failure/unknown rather than success;
- check the provider's success result and any application-relevant hostname/action expectations;
- avoid logging the full token or secret;
- keep replay/duplicate-submission behavior explicit for the application.

Do not trust the presence of a client token alone.

## Deployment

This skill does not own deployment.

Do not:
- clone floating templates during deployment;
- install floating global CLI versions under production credentials;
- recursively delete an arbitrary deployment directory;
- create or destroy Cloudflare resources unless the user requested that separate infrastructure action.

If deployment is required, use the repository's existing deployment workflow or a separately reviewed, pinned infrastructure path.

## Verification

Test at least:
1. expected valid challenge path;
2. missing token;
3. invalid/expired token;
4. provider/network failure;
5. server logging/redaction behavior.

Use provider-supported test credentials where appropriate rather than production secrets in tests.

After implementation, verify that no secret appears in client bundles, tracked files, logs, screenshots, or generated artifacts.
