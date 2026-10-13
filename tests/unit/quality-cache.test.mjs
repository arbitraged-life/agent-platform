import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const wrapper = new URL('../../scripts/quality-cache.mjs', import.meta.url);
const launcher = `import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
const source = await readFile('input.txt', 'utf8');
if (args.includes('--dry=json')) {
  console.log(JSON.stringify({tasks:[{taskId:'lint:knip:report',hash:source}]}));
} else {
  const dir = args.find(arg=>arg.startsWith('--cache-dir='))?.slice(12) ?? '_state/quality-cache/turbo';
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,source+'.tar.zst'),'saved report');
  if (process.env.QUALITY_TEST_ORPHAN!=='yes') await writeFile(path.join(dir,source+'-meta.json'),'{}');
  if (process.env.QUALITY_TEST_MUTATE==='yes') await writeFile('input.txt','changed');
  console.log('REPORT_RESULT');
  if (process.env.QUALITY_TEST_FAIL==='yes') { console.log('TOOL_ERROR_DETAIL'); process.exitCode=7; }
}
`;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'quality-cache-test-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(path.join(root,'scripts'),{recursive:true});
  await mkdir(path.join(root,'node_modules/turbo/bin'),{recursive:true});
  await writeFile(path.join(root,'node_modules/turbo/package.json'),'{"type":"module"}');
  await copyFile(wrapper,path.join(root,'scripts/quality-cache.mjs'));
  await writeFile(path.join(root,'node_modules/turbo/bin/turbo'),launcher);
  await writeFile(path.join(root,'input.txt'),'original');
  return root;
}
async function invoke(root, args=[], env={}) {
  try {
    const result=await execute(process.execPath,[path.join(root,'scripts/quality-cache.mjs'),...args],
      {cwd:root,env:{...process.env,...env},timeout:10000});
    return {...result,code:0};
  } catch(error) { return error; }
}
test('stable inputs publish the staged report to the new cache namespace',async t=>{
  const root=await fixture(t);
  const result=await invoke(root);
  assert.equal(result.code,0,result.stderr);
  assert.match(result.stdout,/REPORT_RESULT/);
  assert.equal(await readFile(path.join(root,'_state/quality-cache/turbo-v2/original.tar.zst'),'utf8'),'saved report');
});
test('concurrent source changes discard both output and staged cache',async t=>{
  const root=await fixture(t);
  const result=await invoke(root,[],{QUALITY_TEST_MUTATE:'yes'});
  assert.equal(result.code,2);
  assert.doesNotMatch(result.stdout,/REPORT_RESULT/);
  assert.match(result.stderr,/changed during/);
  assert.deepEqual(await readdir(path.join(root,'_state/quality-cache/turbo-v2')),[]);
  assert.deepEqual((await readdir(path.join(root,'_state/quality-cache'))).filter(x=>x.startsWith('staging-')),[]);
});
test('dry run returns inspectable JSON without publishing a report',async t=>{
  const root=await fixture(t);
  const result=await invoke(root,['--dry=json']);
  assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).tasks[0].hash,'original');
  assert.deepEqual(await readdir(path.join(root,'_state/quality-cache/turbo-v2')),[]);
});
test('remote cache overrides remain rejected',async t=>{
  const root=await fixture(t);
  const result=await invoke(root,['--cache=remote:rw']);
  assert.equal(result.code,2);
  assert.match(result.stderr,/Supported options/);
});

test('incomplete cache archives are not published',async t=>{
  const root=await fixture(t);
  const result=await invoke(root,[],{QUALITY_TEST_ORPHAN:'yes'});
  assert.equal(result.code,2);
  assert.match(result.stderr,/metadata/);
  assert.deepEqual(await readdir(path.join(root,'_state/quality-cache/turbo-v2')),[]);
});
test('failed tool output is labeled as diagnostics, never a valid report',async t=>{
  const root=await fixture(t);
  const result=await invoke(root,[],{QUALITY_TEST_FAIL:'yes'});
  assert.equal(result.code,7);
  assert.match(result.stderr,/Unverified tool failure diagnostics/);
  assert.match(result.stderr,/TOOL_ERROR_DETAIL/);
  assert.doesNotMatch(result.stdout,/REPORT_RESULT/);
  assert.deepEqual(await readdir(path.join(root,'_state/quality-cache/turbo-v2')),[]);
});
