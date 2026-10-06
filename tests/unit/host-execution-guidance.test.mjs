import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const skills = ['chatgpt-harness', 'execution-router'];

for (const name of skills) {
  test(`${name} preserves the host-mediated execution boundary`, async () => {
    const text = await readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(text, /Host execution boundary/);
    assert.match(text, /host-supported delegated task/);
    assert.match(text, /user's computer, registered remote, or saved coding environment/);
    assert.match(text, /Do not operate those environments directly/);
    assert.match(text, /ordinary ChatGPT session/);
    assert.match(text, /host permits that route/);
    assert.match(text, /does not grant access or approval/);
  });
}

test('portable routing distinguishes cloud coordination from the selected executor', async () => {
  const text = await readFile(new URL('../../skills/execution-router/SKILL.md', import.meta.url), 'utf8');
  assert.match(text, /dot's own cloud computer/);
  assert.match(text, /task identifier/);
  assert.match(text, /connection and authorization state/);
  assert.match(text, /explicitly selected environment/);
  assert.match(text, /For the configured local launcher/);
  assert.match(text, /do not invent an additional local-launcher/);
});
