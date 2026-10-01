import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, rmdir, writeFile, readFile, chmod, symlink, unlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { routeTask, validateTask, loadPolicy, resolveProfile, cleanEnvironment, digest, executableIdentity, VERSION } from '../../runtime/execution-router/policy.mjs';
import { prepare, runPrepared, inspect, requestCancel, acceptResult } from '../../runtime/execution-router/dispatch.mjs';
const exec = promisify(execFile);
const fixtureRoots=new Set();
after(async()=>Promise.all([...fixtureRoots].map(root=>rm(root,{recursive:true,force:true}))));
const packet = (workspace, overrides={}) => ({ schema_version:1, task_id:'router-test', project:'AGENT', objective:'Inspect the fixture without changes.', workspace, profile:'codex-readonly', actions:['read'], source_write_authorized:false, delegation_reason:'execution-lifecycle', delegation_detail:'Independent bounded repository loop is needed.', acceptance_criteria:['Report the fixture result.'], references:[], ...overrides });
async function fixture(mode='success') {
 const root=await mkdtemp(path.join(tmpdir(),'execution-router-'));
 fixtureRoots.add(root);
 const workspace=path.join(root,'repo'); await mkdir(workspace);
 await exec('git',['init','-q',workspace]);
 await exec('git',['-C',workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']);
 const bin=path.join(root,'codex');
 await writeFile(bin,`#!/usr/bin/env node\nconst args=process.argv.slice(2);\nif(args.includes('--help')) { ${mode==='slow-doctor'?'setTimeout(()=>{console.log("--ignore-user-config --sandbox --json --ephemeral --output-last-message");process.exit(0);},1200);':'console.log("--ignore-user-config --sandbox --json --ephemeral --output-last-message");process.exit(0);'} }\nif(args.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0); }\nlet prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',async()=>{\nconst fs=await import('node:fs/promises');\nconst i=args.indexOf('--output-last-message');\nif(i>=0) await fs.writeFile(args[i+1],${mode==='final-loud'?"'x'.repeat(500)":"JSON.stringify({summary:'fixture return',prompt_received:prompt.includes('router-test')})"});\nconsole.log(JSON.stringify({type:'fixture',shell:false,args}));\n${mode==='slow'?'setTimeout(()=>process.exit(0),60000);':mode==='poll-race'?'setTimeout(()=>process.exit(0),450);':mode==='fail'?'process.exit(7);':mode==='loud'?'console.log("x".repeat(1000));process.exit(0);':['orphan','stubborn-orphan'].includes(mode)?`const {spawn}=await import('node:child_process');const descendant=spawn(process.execPath,['-e',${JSON.stringify(`${mode==='stubborn-orphan'?"process.on('SIGTERM',()=>{});process.send('ready');":''}setTimeout(()=>require('node:fs/promises').writeFile(${JSON.stringify(path.join(root,'orphan-marker'))},'escaped'),${mode==='stubborn-orphan'?3000:800})`)}],{stdio:${mode==='stubborn-orphan'?"['ignore','ignore','ignore','ipc']":"'ignore'"}});${mode==='stubborn-orphan'?"descendant.once('message',()=>process.exit(0));":"process.exit(0);"}`:'process.exit(0);'}\n});\n`); await chmod(bin,0o700);
 const policyPath=path.join(root,'policy.json');
 const data={schema_version:1,policy_version:'1.0.0',state_dir:path.join(root,'state'),workspace_roots:[workspace],profiles:{'codex-readonly':{adapter:'codex',executable:bin,sandbox:'read-only',actions:['read'],max_seconds:mode==='slow'?1:10,requires_isolated_worktree:false,requires_chatgpt_login:true}}};
 await writeFile(policyPath,JSON.stringify(data));
 return {root,workspace,policyPath,data,policy:await loadPolicy(policyPath)};
}
test('owner-native capability wins over unnecessary delegation',()=>assert.equal(routeTask({native_available:true,local_available:true}).route,'chatgpt-native'));
test('local files use Desktop Commander directly',()=>assert.equal(routeTask({local_available:true}).route,'chatgpt-local'));
test('complexity alone does not create a handoff',()=>assert.equal(routeTask({local_available:true,complexity:'high'}).route,'chatgpt-local'));
test('concrete lifecycle advantage allows local delegation',()=>assert.equal(routeTask({local_available:true,delegate_reason:'execution-lifecycle',delegate_detail:'Need resumable independent loop'}).route,'local-agent'));
test('missing permission blocks instead of rerouting',()=>assert.equal(routeTask({native_available:true,local_available:true,authority_blocked:true}).route,'needs-user'));
test('offline local host does not prevent available cloud work',()=>assert.equal(routeTask({native_available:true,local_available:false}).route,'chatgpt-native'));
test('unsupported capability surfaces a bounded blocker',()=>assert.equal(routeTask({}).route,'needs-user'));
test('route capability flags require actual booleans rather than truthy values',()=>{
 for(const key of ['authority_blocked','native_available','local_available'])for(const value of ['false',1,null])assert.throws(()=>routeTask({[key]:value}),new RegExp(`${key} must be boolean`));
 assert.equal(routeTask({authority_blocked:false,native_available:false,local_available:true}).route,'chatgpt-local');
});
test('route CLI refuses string flags instead of granting a false capability',async()=>{
 const f=await fixture(),facts=path.join(f.root,'facts.json'),cli=new URL('../../scripts/execution/router.mjs',import.meta.url).pathname;
 await writeFile(facts,JSON.stringify({native_available:false,local_available:true}));
 assert.equal(JSON.parse((await exec(process.execPath,[cli,'route','--facts',facts])).stdout).route,'chatgpt-local');
 await writeFile(facts,JSON.stringify({native_available:'false',local_available:true}));
 await assert.rejects(()=>exec(process.execPath,[cli,'route','--facts',facts]),/native_available must be boolean/);
});
test('unknown future projects keep write authorization required',()=>assert.throws(()=>validateTask(packet('/tmp/repo',{project:'NEW',actions:['edit']})),/write authorization/));
test('SEARCH research cannot silently mutate source',()=>assert.throws(()=>validateTask(packet('/tmp/repo',{project:'SEARCH',actions:['edit']})),/write authorization/));
test('explicit SEARCH action may be scoped',()=>assert.equal(validateTask(packet('/tmp/repo',{project:'SEARCH',actions:['edit'],source_write_authorized:true})).project,'SEARCH'));
for(const id of ['../escape','/tmp/x','a b','a;echo bad',''])test(`reject task id ${JSON.stringify(id)}`,()=>assert.throws(()=>validateTask(packet('/tmp/repo',{task_id:id})),/task_id/));
test('reject unknown task fields to prevent executor injection',()=>assert.throws(()=>validateTask(packet('/tmp/repo',{command:'rm -rf /'})),/Unknown task field/));
test('reject unsupported delegation reason',()=>assert.throws(()=>validateTask(packet('/tmp/repo',{delegation_reason:'because-code'})),/delegation_reason/));
test('reject an obvious embedded credential',()=>assert.throws(()=>validateTask(packet('/tmp/repo',{objective:['-----BEGIN','PRIVATE','KEY-----'].join(' ')})),/credential/));
test('reject common AWS key and bearer credential shapes in task packets',()=>{for(const objective of ['AKIA'+'A'.repeat(16),'Bearer '+'synthetic'.repeat(4)])assert.throws(()=>validateTask(packet('/tmp/repo',{objective})),/credential/);});
test('strip credential environment and retain ordinary process needs',()=>{const env=cleanEnvironment({HOME:'/tmp/example-home',PATH:'/bin',OPENAI_API_KEY:'bad',CODEX_API_KEY:'bad',GH_TOKEN:'bad',OPIK_API_KEY:'bad',NODE_OPTIONS:'bad',HTTPS_PROXY:'bad'});assert.equal(env.HOME,'/tmp/example-home');assert.equal(env.GH_TOKEN,undefined);assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);});
test('stable digest ignores object key order',()=>assert.equal(digest({a:1,b:2}),digest({b:2,a:1})));
test('realpath rejects a symlink escape',async()=>{const f=await fixture();const outside=await mkdtemp(path.join(tmpdir(),'outside-'));await symlink(outside,path.join(f.workspace,'escape'));await assert.rejects(()=>resolveProfile(f.policy,packet(path.join(f.workspace,'escape'))),/outside allowed/);});
test('tracked symlinks must not expose files outside the approved repository',async()=>{const f=await fixture();const outside=path.join(f.root,'private.txt');await writeFile(outside,'private');await symlink(outside,path.join(f.workspace,'linked.txt'));await exec('git',['-C',f.workspace,'add','linked.txt']);await assert.rejects(()=>prepare(f.policy,packet(f.workspace)),/symlink.*outside workspace/i);});
test('repository-provided Git hooks cannot run during preparation',async()=>{const f=await fixture();const marker=path.join(f.root,'hook-ran');const hook=path.join(f.root,'fsmonitor');await writeFile(hook,`#!/bin/sh\nprintf ran > '${marker}'\n`);await chmod(hook,0o700);await exec('git',['-C',f.workspace,'config','core.fsmonitor',hook]);await prepare(f.policy,packet(f.workspace));await assert.rejects(()=>readFile(marker),{code:'ENOENT'});});
test('repository-provided Git clean filters cannot run during preparation',async()=>{const f=await fixture();const marker=path.join(f.root,'filter-ran');await writeFile(path.join(f.workspace,'tracked.txt'),'first');await exec('git',['-C',f.workspace,'add','tracked.txt']);await writeFile(path.join(f.workspace,'.gitattributes'),'*.txt filter=evil\n');const filter=path.join(f.root,'filter');await writeFile(filter,`#!/bin/sh\nprintf ran > '${marker}'\ncat\n`);await chmod(filter,0o700);await exec('git',['-C',f.workspace,'config','filter.evil.clean',filter]);await writeFile(path.join(f.workspace,'tracked.txt'),'modified');await prepare(f.policy,packet(f.workspace));await assert.rejects(()=>readFile(marker),{code:'ENOENT'});});
test('submodules are refused until their nested worktree can be fingerprinted',async()=>{const f=await fixture();const source=path.join(f.root,'nested');await exec('git',['init','-q',source]);await exec('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']);await exec('git',['-C',f.workspace,'-c','protocol.file.allow=always','submodule','add','-q',source,'nested']);await assert.rejects(()=>prepare(f.policy,packet(f.workspace)),/submodule.*unsupported/i);});
test('tracked symlink target drift invalidates launch',async()=>{const f=await fixture();await writeFile(path.join(f.workspace,'first.txt'),'first');await writeFile(path.join(f.workspace,'second.txt'),'second');await symlink('first.txt',path.join(f.workspace,'linked.txt'));await exec('git',['-C',f.workspace,'add','linked.txt','first.txt','second.txt']);const p=await prepare(f.policy,packet(f.workspace));await writeFile(path.join(f.workspace,'first.txt'),'changed');await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);});
test('untracked and ignored symlink text and resolved target identity invalidate approval with unchanged file bytes',async()=>{
 for(const kind of ['untracked','ignored'])for(const target of ['same-target','different-target']) {
  const f=await fixture(),linked=path.join(f.workspace,'linked.local');
  if(kind==='ignored')await writeFile(path.join(f.workspace,'.gitignore'),'*.local\n');
  await writeFile(path.join(f.workspace,'first.txt'),'same bytes');
  await writeFile(path.join(f.workspace,'second.txt'),'same bytes');
  await symlink('first.txt',linked);
  const p=await prepare(f.policy,packet(f.workspace));
  await unlink(linked);
  await symlink(target==='same-target'?'./first.txt':'second.txt',linked);
  await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);
 }
});
test('symlink targets must have independently fingerprinted bytes, including excluded state and Git metadata',async()=>{for(const target of ['.router-state/input','.router-state/state-alias/input','.git/config']){const f=await fixture();f.data.state_dir=path.join(f.workspace,'.router-state');await writeFile(f.policyPath,JSON.stringify(f.data));await writeFile(path.join(f.workspace,'.gitignore'),'.router-state/\n');await mkdir(f.data.state_dir);await writeFile(path.join(f.data.state_dir,'input'),'private');if(target.includes('state-alias'))await symlink('.',path.join(f.data.state_dir,'state-alias'));await symlink(target,path.join(f.workspace,'linked.txt'));await exec('git',['-C',f.workspace,'add','linked.txt']);const policy=await loadPolicy(f.policyPath);await assert.rejects(()=>prepare(policy,packet(f.workspace)),/symlink target.*not independently fingerprinted/i);}});
test('tracked links to independently fingerprinted ignored inputs remain valid',async()=>{const f=await fixture();await writeFile(path.join(f.workspace,'.gitignore'),'*.local\n');await writeFile(path.join(f.workspace,'input.local'),'approved');await symlink('input.local',path.join(f.workspace,'linked.txt'));await exec('git',['-C',f.workspace,'add','linked.txt']);const p=await prepare(f.policy,packet(f.workspace));assert.equal(p.status,'prepared');await writeFile(path.join(f.workspace,'input.local'),'modified');await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);});
test('state above workspace does not exclude symlinked inputs inside workspace',async()=>{const f=await fixture();f.data.state_dir=f.root;await writeFile(f.policyPath,JSON.stringify(f.data));await writeFile(path.join(f.workspace,'.gitignore'),'*.local\n');await writeFile(path.join(f.workspace,'input.local'),'approved');await symlink('input.local',path.join(f.workspace,'linked.txt'));await exec('git',['-C',f.workspace,'add','linked.txt']);const policy=await loadPolicy(f.policyPath);const p=await prepare(policy,packet(f.workspace));assert.equal(p.status,'prepared');await writeFile(path.join(f.workspace,'input.local'),'modified');await assert.rejects(()=>runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);});
test('policy does not accept dangerous sandbox',async()=>{const f=await fixture();f.data.profiles['codex-readonly'].sandbox='danger-full-access';await writeFile(f.policyPath,JSON.stringify(f.data));await assert.rejects(()=>loadPolicy(f.policyPath),/sandbox/);});
test('prototype-keyed profiles bind approval and inherited names cannot select an executor',async()=>{const f=await fixture();f.data.profiles=JSON.parse(`{"codex-readonly":${JSON.stringify(f.data.profiles['codex-readonly'])},"__proto__":${JSON.stringify(f.data.profiles['codex-readonly'])}}`);await writeFile(f.policyPath,JSON.stringify(f.data));const loaded=await loadPolicy(f.policyPath);const approved=await prepare(loaded,packet(f.workspace,{profile:'__proto__'}));for(const profile of ['constructor','toString'])await assert.rejects(()=>resolveProfile(loaded,packet(f.workspace,{profile})),/Unknown profile/);f.data.profiles.__proto__.max_seconds++;await writeFile(f.policyPath,JSON.stringify(f.data));const changed=await loadPolicy(f.policyPath);await assert.rejects(()=>runPrepared(changed,'router-test',{approved_digest:approved.approval_digest,approval_ref:'user approved fixture'}),/policy changed/);});
test('prepare produces a digest-bound approval packet but never launches',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));assert.equal(p.status,'prepared');assert.match(p.approval_digest,/^[a-f0-9]{64}$/);assert.equal((await inspect(f.policy,'router-test')).status,'prepared');});
test('duplicate task IDs are refused, not rerun',async()=>{const f=await fixture();await prepare(f.policy,packet(f.workspace));await assert.rejects(()=>prepare(f.policy,packet(f.workspace)),/already exists/);});
test('run requires explicit approval evidence',async()=>{const f=await fixture();await prepare(f.policy,packet(f.workspace));await assert.rejects(()=>runPrepared(f.policy,'router-test',{}),/approval/);assert.equal((await inspect(f.policy,'router-test')).status,'prepared');});
test('edited packet invalidates approval digest',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));const file=path.join(f.policy.state_dir,'runs','router-test','packet.json');const changed=JSON.parse(await readFile(file,'utf8'));changed.objective='Different action';await writeFile(file,JSON.stringify(changed));await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/digest/);});
test('workspace drift invalidates prepared approval',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));await writeFile(path.join(f.workspace,'new.txt'),'drift');await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);});
test('creating or removing untracked and ignored empty directories invalidates approval',async()=>{
 for(const kind of ['untracked','ignored'])for(const change of ['create','remove']) {
  const f=await fixture(),dir=path.join(f.workspace,'empty.cache');
  if(kind==='ignored')await writeFile(path.join(f.workspace,'.gitignore'),'*.cache/\n');
  if(change==='remove')await mkdir(dir);
  const p=await prepare(f.policy,packet(f.workspace));
  if(change==='create')await mkdir(dir);else await rmdir(dir);
  await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);
 }
});
test('ignored execution input drift invalidates launch',async()=>{const f=await fixture();await writeFile(path.join(f.workspace,'.gitignore'),'*.local\n');await writeFile(path.join(f.workspace,'config.local'),'first');const p=await prepare(f.policy,packet(f.workspace));await writeFile(path.join(f.workspace,'config.local'),'second');await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);});
test('new ignored execution input invalidates launch',async()=>{const f=await fixture();await writeFile(path.join(f.workspace,'.gitignore'),'*.local\n');const p=await prepare(f.policy,packet(f.workspace));await writeFile(path.join(f.workspace,'config.local'),'new');await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);});
test('ignored private state inside a read-only workspace does not invalidate its own approval',async()=>{const f=await fixture();f.data.state_dir=path.join(f.workspace,'.router-state');await writeFile(path.join(f.workspace,'.gitignore'),'.router-state/\n');await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath);const p=await prepare(policy,packet(f.workspace));const result=await runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});assert.equal(result.status,'returned');});
test('nested ignored router state does not change approval of its empty parent',async()=>{
 const f=await fixture(),cache=path.join(f.workspace,'cache');
 await mkdir(cache);
 f.data.state_dir=path.join(cache,'.router-state');
 await writeFile(path.join(f.workspace,'.gitignore'),'cache/.router-state/\n');
 await writeFile(f.policyPath,JSON.stringify(f.data));
 const policy=await loadPolicy(f.policyPath),p=await prepare(policy,packet(f.workspace));
 const result=await runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});
 assert.equal(result.status,'returned');assert.equal(result.workspace_changed,false);
});
test('fresh nested ignored router state preserves approval on first launch',async()=>{
 const f=await fixture(),cache=path.join(f.workspace,'cache');
 f.data.state_dir=path.join(cache,'.router-state');
 await writeFile(path.join(f.workspace,'.gitignore'),'cache/.router-state/\n');
 await writeFile(f.policyPath,JSON.stringify(f.data));
 const policy=await loadPolicy(f.policyPath),p=await prepare(policy,packet(f.workspace));
 const result=await runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});
 assert.equal(result.status,'returned');assert.equal(result.workspace_changed,false);
});
test('doctor-time workspace edits invalidate approval before the child starts',async()=>{
 const f=await fixture(),file=path.join(f.workspace,'input.txt');
 await writeFile(file,'approved');
 await writeFile(f.data.profiles['codex-readonly'].executable,`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--help')){fs.writeFileSync(${JSON.stringify(file)},'changed during doctor');console.log('--ignore-user-config --sandbox --json --ephemeral --output-last-message');process.exit(0);}
if(args.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
process.exit(0);
`);
 await chmod(f.data.profiles['codex-readonly'].executable,0o700);
 const p=await prepare(f.policy,packet(f.workspace));
 await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed before launch/);
});
test('unignored in-workspace state is not excluded from approval',async()=>{
 const f=await fixture();
 f.data.state_dir=path.join(f.workspace,'.router-state');
 await writeFile(f.policyPath,JSON.stringify(f.data));
 const policy=await loadPolicy(f.policyPath),p=await prepare(policy,packet(f.workspace));
 await assert.rejects(()=>runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);
});
test('policy change invalidates prepared approval',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));f.data.profiles['codex-readonly'].max_seconds=11;await writeFile(f.policyPath,JSON.stringify(f.data));const next=await loadPolicy(f.policyPath);await assert.rejects(()=>runPrepared(next,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/policy changed/);});
test('router upgrades and modified version records require a new approval',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));const file=path.join(f.policy.state_dir,'runs','router-test','status.json');const original=JSON.parse(await readFile(file,'utf8'));await writeFile(file,JSON.stringify({...original,router_version:'1.0.1'}));await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/router version/);const legacy=digest({packet:packet(f.workspace),policy:f.policy.config_digest,workspace:p.workspace_fingerprint,expires_at:p.expires_at});await writeFile(file,JSON.stringify({...original,approval_digest:legacy}));await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:legacy,approval_ref:'user approved fixture'}),/router version or approval changed/);assert.equal((await inspect(f.policy,'router-test')).status,'prepared');});
test('successful child return is not verified completion',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));const result=await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});assert.equal(result.status,'returned');assert.equal(result.exit_code,0);assert.equal(result.verified,false);const answer=JSON.parse(await readFile(path.join(f.policy.state_dir,'runs','router-test','agent-final.txt'),'utf8'));assert.equal(answer.prompt_received,true);});
test('failed child records exit code without success',async()=>{const f=await fixture('fail');const p=await prepare(f.policy,packet(f.workspace));const r=await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});assert.equal(r.status,'failed');assert.equal(r.exit_code,7);});
test('profile output ceiling stops a noisy child below the default limit',async()=>{const f=await fixture('loud');f.data.profiles['codex-readonly'].max_output_bytes=200;await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath);const p=await prepare(policy,packet(f.workspace));const r=await runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});assert.equal(r.status,'output-limit');});
test('unknown policy limits fail closed rather than being silently ignored',async()=>{const f=await fixture();f.data.max_output_bytes=200;await writeFile(f.policyPath,JSON.stringify(f.data));await assert.rejects(()=>loadPolicy(f.policyPath),/Unknown policy setting/);});
test('wall-clock limit terminates owned process',async()=>{const f=await fixture('slow');const p=await prepare(f.policy,packet(f.workspace));const r=await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});assert.equal(r.status,'timed-out');assert.equal(r.verified,false);});
test('cancellation works through supervisor, not arbitrary PID',async()=>{const f=await fixture('slow');f.data.profiles['codex-readonly'].max_seconds=10;await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath);const p=await prepare(policy,packet(f.workspace));const running=runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});for(let i=0;i<1500;i++){if((await inspect(policy,'router-test')).status==='running')break;await new Promise(r=>setTimeout(r,20));}await requestCancel(policy,'router-test');assert.equal((await running).status,'cancelled');});
test('no automatic retry after a completed launch',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/not prepared/);});
test('verification records controller evidence and digest',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});const artifact=path.join(f.policy.state_dir,'runs','router-test','agent-final.txt');const evidence={verifier:'chatgpt-controller',summary:'Read back expected fixture output.',criteria:[{criterion:'Report the fixture result.',passed:true,evidence:'Fixture return inspected.'}],artifacts:[artifact]};const r=await acceptResult(f.policy,'router-test',evidence);assert.equal(r.status,'verified-complete');assert.equal(r.verified,true);assert.match(r.verification.artifacts[0].sha256,/^[a-f0-9]{64}$/);});
test('acceptance refuses workspace drift after return and releases its verification lock',async()=>{
 const f=await fixture(),p=await prepare(f.policy,packet(f.workspace));
 const returned=await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});
 assert.equal(returned.status,'returned');
 const artifact=path.join(f.policy.state_dir,'runs','router-test','agent-final.txt');
 const evidence={verifier:'controller',summary:'Inspected the returned fixture.',criteria:[{criterion:'Report the fixture result.',passed:true,evidence:'The fixture returned the expected response.'}],artifacts:[artifact]};
 const changed=path.join(f.workspace,'after-return.txt');await writeFile(changed,'changed after return');
 await assert.rejects(()=>acceptResult(f.policy,'router-test',evidence),/workspace changed since return/i);
 assert.equal((await inspect(f.policy,'router-test')).status,'returned');
 await unlink(changed);
 assert.equal((await acceptResult(f.policy,'router-test',evidence)).status,'verified-complete');
});
test('incomplete acceptance cannot be marked complete',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});await assert.rejects(()=>acceptResult(f.policy,'router-test',{verifier:'controller',summary:'not checked',criteria:[],artifacts:[]}),/criteria/);});
test('concurrent and stale acceptance locks cannot replace the first verified evidence',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});const dir=path.join(f.policy.state_dir,'runs','router-test'),lock=path.join(dir,'accept.lock'),artifact=path.join(dir,'agent-final.txt');const evidence=verifier=>({verifier,summary:'Fixture result inspected.',criteria:[{criterion:'Report the fixture result.',passed:true,evidence:'Fixture result inspected.'}],artifacts:[artifact]});await mkdir(lock);await assert.rejects(()=>acceptResult(f.policy,'router-test',evidence('stale')),/stale lock/);await rmdir(lock);await assert.rejects(()=>acceptResult(f.policy,'router-test',{...evidence('invalid'),criteria:[]}),/criteria/);const attempts=await Promise.allSettled([acceptResult(f.policy,'router-test',evidence('first')),acceptResult(f.policy,'router-test',evidence('second'))]);const accepted=attempts.filter(a=>a.status==='fulfilled');assert.equal(accepted.length,1);assert.match(attempts.find(a=>a.status==='rejected').reason.message,/Acceptance already in progress|Only a returned run/);const saved=await inspect(f.policy,'router-test');assert.equal(saved.verification.verifier,accepted[0].value.verification.verifier);assert.equal((await readFile(path.join(dir,'events.jsonl'),'utf8')).split('\n').filter(line=>line.includes('\"type\":\"verified-complete\"')).length,1);});
test('post-run packet changes cannot redefine accepted criteria',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});const file=path.join(f.policy.state_dir,'runs','router-test','packet.json');const altered=JSON.parse(await readFile(file,'utf8'));altered.acceptance_criteria=['Approve without original criterion.'];await writeFile(file,JSON.stringify(altered));const artifact=path.join(f.policy.state_dir,'runs','router-test','agent-final.txt');await assert.rejects(()=>acceptResult(f.policy,'router-test',{verifier:'chatgpt-controller',summary:'Accepted modified task.',criteria:[{criterion:'Approve without original criterion.',passed:true,evidence:'Original requirement ignored.'}],artifacts:[artifact]}),/packet digest/i);});
test('artifact hashes are hashes of raw bytes',()=>assert.equal(digest(Buffer.from('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
test('edited rendered handoff invalidates launch',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));await writeFile(path.join(f.policy.state_dir,'runs','router-test','HANDOFF.md'),'Different task');await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/handoff.*changed/i);});
test('doctor-time handoff edits cannot alter launched instructions',async()=>{
 const f=await fixture(),p=await prepare(f.policy,packet(f.workspace)),handOff=p.handoff_path,approved=await readFile(p.handoff_path,'utf8');
 await writeFile(f.data.profiles['codex-readonly'].executable,`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);\nif(args.includes('--help')){fs.writeFileSync(${JSON.stringify(handOff)},'MUTATED AFTER APPROVAL');console.log('--ignore-user-config --sandbox --json --ephemeral --output-last-message');process.exit(0);}\nif(args.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}\nlet input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>fs.writeFileSync(args[args.indexOf('--output-last-message')+1],input));\n`);
 await chmod(f.data.profiles['codex-readonly'].executable,0o700);
 const statePath=path.join(f.policy.state_dir,'runs','router-test','status.json'),packetPath=path.join(f.policy.state_dir,'runs','router-test','packet.json');
 const state=JSON.parse(await readFile(statePath,'utf8')),savedPacket=JSON.parse(await readFile(packetPath,'utf8'));
 state.executable_identity=await executableIdentity(f.policy.profiles['codex-readonly']);
 state.approval_digest=digest({router_version:VERSION,packet:savedPacket,policy:state.policy_digest,workspace:state.workspace_fingerprint,executable:state.executable_identity,expires_at:state.expires_at});
 await writeFile(statePath,JSON.stringify(state));
 const result=await runPrepared(f.policy,'router-test',{approved_digest:state.approval_digest,approval_ref:'user approved fixture'});
 assert.equal(result.status,'returned');assert.equal(await readFile(handOff,'utf8'),'MUTATED AFTER APPROVAL');
 assert.equal(await readFile(path.join(f.policy.state_dir,'runs','router-test','agent-final.txt'),'utf8'),approved);
});
test('different task cannot overlap one workspace',async()=>{const f=await fixture('slow');f.data.profiles['codex-readonly'].max_seconds=30;await writeFile(f.policyPath,JSON.stringify(f.data));f.policy=await loadPolicy(f.policyPath);const first=await prepare(f.policy,packet(f.workspace));const second=await prepare(f.policy,packet(f.workspace,{task_id:'second-test'}));const running=runPrepared(f.policy,'router-test',{approved_digest:first.approval_digest,approval_ref:'user approved fixture'});for(let i=0;i<1500;i++){if((await inspect(f.policy,'router-test')).status==='running')break;await new Promise(r=>setTimeout(r,20));}await assert.rejects(()=>runPrepared(f.policy,'second-test',{approved_digest:second.approval_digest,approval_ref:'user approved fixture'}),/already has a run/);await requestCancel(f.policy,'router-test');await running;});
test('workspace-write is blocked on the ordinary checkout',async()=>{const f=await fixture();f.data.protected_branches=['main','master'];f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit','test'],requires_isolated_worktree:true};await writeFile(f.policyPath,JSON.stringify(f.data));await exec('git',['-C',f.workspace,'checkout','-qb','fixture-feature']);const policy=await loadPolicy(f.policyPath);await assert.rejects(()=>prepare(policy,packet(f.workspace,{profile:'codex-write',actions:['edit'],source_write_authorized:true})),/isolated linked worktree/);});
test('write profiles cannot place mutable control records inside their worktree',async()=>{const f=await fixture();const linked=path.join(f.root,'linked');await exec('git',['-C',f.workspace,'worktree','add','-qb','fixture-feature',linked]);f.data.workspace_roots=[f.root];f.data.state_dir=path.join(linked,'.router-state');f.data.protected_branches=['main','master'];f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit','test'],requires_isolated_worktree:true};await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath);await assert.rejects(()=>prepare(policy,packet(linked,{profile:'codex-write',actions:['edit'],source_write_authorized:true})),/state directory.*outside.*worktree/i);});
test('read-only packets cannot select a writable sandbox',async()=>{const f=await fixture();f.data.protected_branches=['main','master','trunk'];f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit','test'],requires_isolated_worktree:true};await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath);await assert.rejects(()=>resolveProfile(policy,packet(f.workspace,{profile:'codex-write'})),/write.*authorization/i);});
test('private policy must name protected branches before allowing write profiles',async()=>{const f=await fixture();f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit','test'],requires_isolated_worktree:true};await writeFile(f.policyPath,JSON.stringify(f.data));await assert.rejects(()=>loadPolicy(f.policyPath),/protected_branches/);});
test('protected project branch in a linked worktree cannot be written',async()=>{const f=await fixture();const linked=path.join(f.root,'linked');await exec('git',['-C',f.workspace,'worktree','add','-qb','trunk',linked]);f.data.workspace_roots=[f.root];f.data.protected_branches=['main','master','trunk'];f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit','test'],requires_isolated_worktree:true};await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath);await assert.rejects(()=>prepare(policy,packet(linked,{profile:'codex-write',actions:['edit'],source_write_authorized:true})),/non-protected feature branch/);});
test('a feature branch rename at the same HEAD invalidates approval',async()=>{
 const f=await fixture(),linked=path.join(f.root,'linked');
 await exec('git',['-C',f.workspace,'worktree','add','-qb','fixture-feature',linked]);
 f.data.workspace_roots=[f.root];f.data.protected_branches=['trunk'];
 f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit','test'],requires_isolated_worktree:true};
 await writeFile(f.policyPath,JSON.stringify(f.data));
 const policy=await loadPolicy(f.policyPath),p=await prepare(policy,packet(linked,{profile:'codex-write',actions:['edit'],source_write_authorized:true}));
 await exec('git',['-C',linked,'branch','-m','another-feature']);
 await assert.rejects(()=>runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);
});
test('a same-HEAD branch rename ending in NBSP cannot reuse approval',async()=>{
 const f=await fixture(),linked=path.join(f.root,'linked');
 await exec('git',['-C',f.workspace,'worktree','add','-qb','fixture-feature',linked]);
 f.data.workspace_roots=[f.root];f.data.protected_branches=['trunk'];
 f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit','test'],requires_isolated_worktree:true};
 await writeFile(f.policyPath,JSON.stringify(f.data));
 const policy=await loadPolicy(f.policyPath),p=await prepare(policy,packet(linked,{profile:'codex-write',actions:['edit'],source_write_authorized:true}));
 await exec('git',['-C',linked,'branch','-m','fixture-feature\u00a0']);
 await assert.rejects(()=>runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);
 await assert.rejects(()=>readFile(path.join(policy.state_dir,'runs','router-test','agent-final.txt')),{code:'ENOENT'});
});
test('doctor-time switch to a protected branch blocks writable launch',async()=>{
 const f=await fixture(),linked=path.join(f.root,'linked');
 await exec('git',['-C',f.workspace,'worktree','add','-qb','fixture-feature',linked]);
 f.data.workspace_roots=[f.root];f.data.protected_branches=['trunk'];
 f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit','test'],requires_isolated_worktree:true};
 await writeFile(f.policyPath,JSON.stringify(f.data));
 await writeFile(f.data.profiles['codex-readonly'].executable,`#!/usr/bin/env node
const cp=require('node:child_process'),args=process.argv.slice(2);
if(args.includes('--help')){cp.execFileSync('git',['-C',${JSON.stringify(linked)},'branch','-m','trunk']);console.log('--ignore-user-config --sandbox --json --ephemeral --output-last-message');process.exit(0);}
if(args.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
process.exit(0);
`);
 await chmod(f.data.profiles['codex-readonly'].executable,0o700);
 const policy=await loadPolicy(f.policyPath),p=await prepare(policy,packet(linked,{profile:'codex-write',actions:['edit'],source_write_authorized:true}));
 await assert.rejects(()=>runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/non-protected feature branch/);
});
test('source test actions require write authority because tests execute code',()=>assert.throws(()=>validateTask(packet('/tmp/repo',{actions:['test']})),/write authorization/));
test('detached process-group descendants cannot outlive release of a workspace',async()=>{const f=await fixture('orphan');const p=await prepare(f.policy,packet(f.workspace));const r=await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});assert.equal(r.status,'needs-review');await new Promise(resolve=>setTimeout(resolve,1200));await assert.rejects(()=>readFile(path.join(f.root,'orphan-marker')),{code:'ENOENT'});});
test('manual profiles produce handoff but do not launch an unvalidated adapter',async()=>{const f=await fixture();f.data.profiles.manual={adapter:'manual',sandbox:'read-only',actions:['read'],max_seconds:60};await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath);const p=await prepare(policy,packet(f.workspace,{profile:'manual'}));assert.equal(p.handoff_only,true);await assert.rejects(()=>runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/Handoff-only/);});
test('CLI help is available without machine policy',async()=>{const r=await exec(process.execPath,[new URL('../../scripts/execution/router.mjs',import.meta.url).pathname,'--help']);assert.match(r.stdout,/prepare/);assert.match(r.stdout,/approved-digest/);});
test('CLI refuses unrecognized flags',async()=>{await assert.rejects(()=>exec(process.execPath,[new URL('../../scripts/execution/router.mjs',import.meta.url).pathname,'route','--unsafe','yes']),/Unknown option/);});
test('CLI doctor serializes a configured __proto__ profile rather than losing its result',async()=>{const f=await fixture();f.data.profiles=JSON.parse('{"__proto__":{"adapter":"manual","sandbox":"read-only","actions":["read"],"max_seconds":60}}');await writeFile(f.policyPath,JSON.stringify(f.data));const {stdout}=await exec(process.execPath,[new URL('../../scripts/execution/router.mjs',import.meta.url).pathname,'doctor','--policy',f.policyPath,'--profile','__proto__']);const result=JSON.parse(stdout);assert.deepEqual(result.profiles['__proto__'],{status:'handoff-only'});});
test('verification accepts artifacts through a symlinked state path',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});const alias=path.join(f.root,'state-alias');await symlink(f.policy.state_dir,alias);const linked={...f.policy,state_dir:alias};const artifact=path.join(alias,'runs','router-test','agent-final.txt');const result=await acceptResult(linked,'router-test',{verifier:'controller',summary:'Read the expected fixture output through its canonical path.',criteria:[{criterion:'Report the fixture result.',passed:true,evidence:'Expected fixture response inspected.'}],artifacts:[artifact]});assert.equal(result.status,'verified-complete');});
test('Codex requires a usable executable while manual handoffs do not',async()=>{const f=await fixture();f.data.profiles['codex-readonly'].executable='';f.data.profiles.manual={adapter:'manual',sandbox:'read-only',actions:['read'],max_seconds:60};await writeFile(f.policyPath,JSON.stringify(f.data));await assert.rejects(()=>loadPolicy(f.policyPath),/executable for Codex/);delete f.data.profiles['codex-readonly'];await writeFile(f.policyPath,JSON.stringify(f.data));assert.equal((await loadPolicy(f.policyPath)).profiles.manual.executable,undefined);});
test('moving relative executable policy invalidates an already prepared approval',async()=>{const f=await fixture();f.data.profiles['codex-readonly'].executable='./codex';await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath),p=await prepare(policy,packet(f.workspace));const other=path.join(f.root,'other');await mkdir(other);const relocated=path.join(other,'policy.json');await writeFile(relocated,JSON.stringify(f.data));const changed=await loadPolicy(relocated);assert.notEqual(changed.config_digest,policy.config_digest);await assert.rejects(()=>runPrepared(changed,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/policy changed/);});
test('same-tree Git HEAD changes invalidate approval before launch',async()=>{const f=await fixture();const p=await prepare(f.policy,packet(f.workspace));await exec('git',['-C',f.workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','same tree']);await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);});
test('ignored files remain in approval fingerprint when state contains the workspace',async()=>{const f=await fixture();f.data.state_dir=f.root;await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath);await writeFile(path.join(f.workspace,'.gitignore'),'*.local\n');await writeFile(path.join(f.workspace,'input.local'),'first');const p=await prepare(policy,packet(f.workspace));await writeFile(path.join(f.workspace,'input.local'),'second');await assert.rejects(()=>runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);});
test('tracked, ignored, and untracked hard links cannot alias files outside the workspace',async()=>{for(const kind of ['tracked','ignored','untracked']){const f=await fixture(),outside=path.join(f.root,'outside.txt'),inside=path.join(f.workspace,'linked.txt');await writeFile(outside,'external content');await link(outside,inside);if(kind==='tracked')await exec('git',['-C',f.workspace,'add','linked.txt']);if(kind==='ignored')await writeFile(path.join(f.workspace,'.gitignore'),'linked.txt\n');await assert.rejects(()=>prepare(f.policy,packet(f.workspace)),/Hard-linked/);}});
test('tracked Git metadata beyond 4 MiB remains covered by approval drift checks',async()=>{const f=await fixture(),hash=execFileSync('git',['-C',f.workspace,'hash-object','-w','--stdin'],{input:'fixture'}).toString().trim();const records=Array.from({length:19000},(_,i)=>`100644 ${hash}\tmissing/${String(i).padStart(5,'0')}-${'a'.repeat(225)}\0`).join('');execFileSync('git',['-C',f.workspace,'update-index','-z','--index-info'],{input:records});const p=await prepare(f.policy,packet(f.workspace));assert.equal(p.status,'prepared');await mkdir(path.join(f.workspace,'missing'));await writeFile(path.join(f.workspace,`missing/18999-${'a'.repeat(225)}`),'changed after approval');await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/);});
test('settling pending cancellation polls after return cannot signal the former child',async()=>{
 const f=await fixture('poll-race'),p=await prepare(f.policy,packet(f.workspace));
 await writeFile(path.join(f.policy.state_dir,'runs','router-test','cancel.request'),'cancel');
 const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {ChildProcess} from 'node:child_process';import assert from 'node:assert/strict';
 let release,entered,returned=false;const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>entered=resolve),calls=[],lateSignals=[];
 const stat=fs.promises.stat,kill=process.kill,childKill=ChildProcess.prototype.kill;
 fs.promises.stat=(...args)=>{if(!String(args[0]).endsWith('cancel.request'))return stat(...args);entered();const call=gate.then(()=>stat(...args));calls.push(call);return call;};
 process.kill=(pid,signal)=>{if(returned){lateSignals.push({pid,signal});return true;}return kill(pid,signal);};
 ChildProcess.prototype.kill=function(signal){if(returned){lateSignals.push({pid:this.pid,signal});return true;}return childKill.call(this,signal);};
 syncBuiltinESMExports();
 const {loadPolicy}=await import(${JSON.stringify(new URL('../../runtime/execution-router/policy.mjs',import.meta.url).href)}),{runPrepared}=await import(${JSON.stringify(new URL('../../runtime/execution-router/dispatch.mjs',import.meta.url).href)});
 const result=await runPrepared(await loadPolicy(${JSON.stringify(f.policyPath)}),'router-test',{approved_digest:${JSON.stringify(p.approval_digest)},approval_ref:'user approved fixture'});
 assert.equal(result.status,'returned');await pending;returned=true;release();await Promise.all(calls);await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(lateSignals,[]);`;
 await exec(process.execPath,['--input-type=module','-e',script],{timeout:10000});
});
test('tracked-file hashing does not consume the Git transport deadline',async()=>{
 const f=await fixture(),file=path.join(f.workspace,'tracked.txt');
 await writeFile(file,'tracked content');await exec('git',['-C',f.workspace,'add','tracked.txt']);
 const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
 const pending=new Map(),set=globalThis.setTimeout,clear=globalThis.clearTimeout,stat=fs.promises.lstat;
 globalThis.setTimeout=(fn,delay,...args)=>{const timer=set(fn,delay,...args);pending.set(timer,()=>fn(...args));return timer;};
 globalThis.clearTimeout=timer=>{pending.delete(timer);return clear(timer);};
 fs.promises.lstat=async(...args)=>{if(args[0]===${JSON.stringify(file)})for(const expire of pending.values())expire();return stat(...args);};
 syncBuiltinESMExports();
 const {loadPolicy}=await import(${JSON.stringify(new URL('../../runtime/execution-router/policy.mjs',import.meta.url).href)});
 const {prepare}=await import(${JSON.stringify(new URL('../../runtime/execution-router/dispatch.mjs',import.meta.url).href)});
 const result=await prepare(await loadPolicy(${JSON.stringify(f.policyPath)}),${JSON.stringify(packet(f.workspace))});
 assert.equal(result.status,'prepared');`;
 await exec(process.execPath,['--input-type=module','-e',script],{timeout:10000});
});
test('prepared approval binds executable bytes at the configured path',async()=>{
 const f=await fixture(),p=await prepare(f.policy,packet(f.workspace));
 await writeFile(f.data.profiles['codex-readonly'].executable,`#!/usr/bin/env node\nprocess.exit(0);\n`);
 await chmod(f.data.profiles['codex-readonly'].executable,0o700);
 await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/executable changed/i);
});
test('final-message bytes count against the profile output limit',async()=>{
 const f=await fixture('final-loud'),limit=800;f.data.profiles['codex-readonly'].max_output_bytes=limit;
 await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath),p=await prepare(policy,packet(f.workspace));
 const result=await runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});
 const dir=path.join(f.policy.state_dir,'runs','router-test'),stdout=await readFile(path.join(dir,'stdout.jsonl')),final=await readFile(path.join(dir,'agent-final.txt'));
 assert.equal(result.status,'output-limit');assert.ok(stdout.length<limit);assert.ok(stdout.length+final.length>limit);
});
test('unreadable final-message size cannot produce a successful return',async()=>{
 const f=await fixture(),p=await prepare(f.policy,packet(f.workspace)),finalPath=path.join(f.policy.state_dir,'runs','router-test','agent-final.txt');
 const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
const stat=fs.promises.stat;fs.promises.stat=(filename,...args)=>{if(String(filename)===${JSON.stringify(finalPath)}){const error=new Error('synthetic final size denied');error.code='EACCES';return Promise.reject(error);}return stat(filename,...args);};syncBuiltinESMExports();
const {loadPolicy}=await import(${JSON.stringify(new URL('../../runtime/execution-router/policy.mjs',import.meta.url).href)}),{runPrepared}=await import(${JSON.stringify(new URL('../../runtime/execution-router/dispatch.mjs',import.meta.url).href)});
const result=await runPrepared(await loadPolicy(${JSON.stringify(f.policyPath)}),'router-test',{approved_digest:${JSON.stringify(p.approval_digest)},approval_ref:'user approved fixture'});
assert.equal(result.status,'failed');assert.match(result.error,/synthetic final size denied/);`;
 await exec(process.execPath,['--input-type=module','-e',script],{timeout:10000});
});
test('late supervisor log-write failures cannot leave a run returned',async()=>{
 const f=await fixture(),p=await prepare(f.policy,packet(f.workspace));
 await mkdir(path.join(f.policy.state_dir,'runs','router-test','stdout.jsonl'));
 const result=await runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'});
 assert.equal(result.status,'failed');assert.match(result.error,/EISDIR/);
});
test('approval expiry is rechecked after slow doctor work and before launch',async()=>{
 const f=await fixture('slow-doctor'),p=await prepare(f.policy,packet(f.workspace));
 const statePath=path.join(f.policy.state_dir,'runs','router-test','status.json'),packetPath=path.join(f.policy.state_dir,'runs','router-test','packet.json'),state=JSON.parse(await readFile(path.join(f.policy.state_dir,'runs','router-test','status.json'),'utf8'));
 state.expires_at=new Date(Date.now()+700).toISOString();
 state.approval_digest=digest({router_version:VERSION,packet:JSON.parse(await readFile(packetPath,'utf8')),policy:f.policy.config_digest,workspace:p.workspace_fingerprint,executable:p.executable_identity,expires_at:state.expires_at});
 await writeFile(statePath,JSON.stringify(state));
 await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:state.approval_digest,approval_ref:'user approved fixture'}),/approval expired before launch/i);
});
test('untracked executable-bit drift invalidates prepared approval',async()=>{
 const f=await fixture(),file=path.join(f.workspace,'tool.sh');await writeFile(file,'#!/bin/sh\\nexit 0\\n');await chmod(file,0o600);
 const p=await prepare(f.policy,packet(f.workspace));await chmod(file,0o700);
 await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/i);
});
test('undecodable tracked Git paths fail closed instead of colliding after replacement decoding',async()=>{
 const f=await fixture(),name=Buffer.from([0x62,0x61,0xff,0x64]);
 const hash=execFileSync('git',['-C',f.workspace,'hash-object','-w','--stdin'],{input:'invalid path fixture'}).toString().trim();
 execFileSync('git',['-C',f.workspace,'update-index','-z','--index-info'],{input:Buffer.concat([Buffer.from(`100644 ${hash}\t`),name,Buffer.from([0])])});
 await assert.rejects(()=>prepare(f.policy,packet(f.workspace)),/valid UTF-8/i);
});
test('executable replacement during doctor checks blocks the launch',async()=>{
 const f=await fixture(),bin=f.data.profiles['codex-readonly'].executable,marker=path.join(f.root,'launched');
 const replacement=`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--help'))console.log('--ignore-user-config --sandbox --json --ephemeral --output-last-message');else if(args.includes('status'))console.log('Logged in using ChatGPT');else fs.writeFileSync(${JSON.stringify(marker)},'launched');\n`;
 await writeFile(bin,`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--help')){fs.writeFileSync(${JSON.stringify(bin)},${JSON.stringify(replacement)});console.log('--ignore-user-config --sandbox --json --ephemeral --output-last-message');}else if(args.includes('status'))console.log('Logged in using ChatGPT');\n`);
 await chmod(bin,0o700);const policy=await loadPolicy(f.policyPath),p=await prepare(policy,packet(f.workspace));
 await assert.rejects(()=>runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/executable changed/i);
 await assert.rejects(()=>readFile(marker),{code:'ENOENT'});
});
test('a tracked UTF-8 BOM-prefixed path cannot alias its unprefixed neighbor in approvals',async()=>{
 const f=await fixture(),plain=path.join(f.workspace,'file.txt'),bom=path.join(f.workspace,'\uFEFFfile.txt');
 await writeFile(plain,'same contents');await writeFile(bom,'same contents');
 await exec('git',['-C',f.workspace,'add','file.txt','\uFEFFfile.txt']);
 const p=await prepare(f.policy,packet(f.workspace));
 await writeFile(bom,'changed contents');
 await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/workspace changed/i);
});


test('non-executable files cannot become approved launch identities',async()=>{
 const f=await fixture();await chmod(path.join(f.root,'codex'),0o600);
 await assert.rejects(()=>prepare(f.policy,packet(f.workspace)),{code:'EACCES'});
});

test('unsupported process-tree supervision fails before launch state is touched',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
 try {
  Object.defineProperty(process,'platform',{...descriptor,value:'win32'});
  await assert.rejects(()=>runPrepared({},'unused'),/Windows.*supervision/i);
 } finally {Object.defineProperty(process,'platform',descriptor);}
});

test('exceptional supervision still kills a SIGTERM-ignoring descendant',async()=>{
 const f=await fixture('stubborn-orphan'),p=await prepare(f.policy,packet(f.workspace));
 const originalKill=process.kill;let injected=false,killed=false,ownedGroup;
 process.kill=(pid,signal)=>{
  if(pid<0)ownedGroup=pid;
  if(pid<0&&signal===0&&!injected){injected=true;throw new Error('injected supervisor failure');}
  if(pid<0&&signal==='SIGKILL')killed=true;
  return originalKill(pid,signal);
 };
 try {
  await assert.rejects(()=>runPrepared(f.policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'}),/injected supervisor failure/);
  assert.equal(killed,true);
  await new Promise(resolve=>setTimeout(resolve,3200));
  await assert.rejects(()=>readFile(path.join(f.root,'orphan-marker')),{code:'ENOENT'});
 } finally {
  process.kill=originalKill;
  if(ownedGroup){try{originalKill(ownedGroup,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
 }
});

test('isolated read-only profiles allow omitted protected branches',async()=>{
 const f=await fixture(),linked=path.join(f.root,'read-only-linked');
 await exec('git',['-C',f.workspace,'worktree','add','-qb','readonly-feature',linked]);
 f.data.workspace_roots=[f.root];f.data.profiles['codex-readonly'].requires_isolated_worktree=true;
 delete f.data.protected_branches;
 await writeFile(f.policyPath,JSON.stringify(f.data));
 const policy=await loadPolicy(f.policyPath);
 assert.equal((await prepare(policy,packet(linked))).status,'prepared');
});

test('returned writes on an agent-selected protected branch cannot be accepted',async()=>{
 const f=await fixture(),linked=path.join(f.root,'accept-linked');
 await exec('git',['-C',f.workspace,'worktree','add','-qb','accept-feature',linked]);
 f.data.workspace_roots=[f.root];f.data.protected_branches=['trunk'];
 f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit'],requires_isolated_worktree:true};
 const bin=f.data.profiles['codex-write'].executable;
 const source=await readFile(bin,'utf8');
 await writeFile(bin,source.replace("const i=args.indexOf", "const cp=await import('node:child_process');await new Promise((resolve,reject)=>cp.execFile('git',['checkout','-qb','trunk'],e=>e?reject(e):resolve()));const i=args.indexOf"));
 await writeFile(f.policyPath,JSON.stringify(f.data));
 const policy=await loadPolicy(f.policyPath),task=packet(linked,{profile:'codex-write',actions:['edit'],source_write_authorized:true});
 const p=await prepare(policy,task);
 assert.equal((await runPrepared(policy,'router-test',{approved_digest:p.approval_digest,approval_ref:'user approved fixture'})).status,'returned');
 const evidence={verifier:'controller',summary:'Inspect returned change',criteria:[{criterion:task.acceptance_criteria[0],passed:true,evidence:'Inspected output'}],artifacts:[path.join(policy.state_dir,'runs','router-test','agent-final.txt')]};
 await assert.rejects(()=>acceptResult(policy,'router-test',evidence),/non-protected feature branch/);
});

test('Unicode whitespace in protected branch names is preserved',async()=>{
 const f=await fixture(),linked=path.join(f.root,'unicode-linked'),branch='trunk\u00a0';
 await exec('git',['-C',f.workspace,'worktree','add','-qb',branch,linked]);
 f.data.workspace_roots=[f.root];f.data.protected_branches=[branch];
 f.data.profiles['codex-write']={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit'],requires_isolated_worktree:true};
 await writeFile(f.policyPath,JSON.stringify(f.data));
 const policy=await loadPolicy(f.policyPath);
 await assert.rejects(()=>prepare(policy,packet(linked,{profile:'codex-write',actions:['edit'],source_write_authorized:true})),/non-protected feature branch/);
});

test('CLI rejects irrelevant command options and fails stale status queries',async()=>{
 const f=await fixture(),cli=new URL('../../scripts/execution/router.mjs',import.meta.url).pathname;
 await assert.rejects(()=>exec(process.execPath,[cli,'doctor','--policy',f.policyPath,'--facts','ignored']),/Unknown option/);
 await prepare(f.policy,packet(f.workspace));
 const stateFile=path.join(f.policy.state_dir,'runs','router-test','status.json');
 const state=JSON.parse(await readFile(stateFile,'utf8'));
 await writeFile(stateFile,JSON.stringify({...state,status:'running',heartbeat_at:'2000-01-01T00:00:00Z'}));
 await assert.rejects(()=>exec(process.execPath,[cli,'status','--policy',f.policyPath,'--task-id','router-test']),error=>error.code===1 && JSON.parse(error.stdout).status==='unknown');
});

test('Git environment overrides cannot disguise a protected source checkout',async()=>{
 const f=await fixture(),linked=path.join(f.root,'linked');
 await exec('git',['-C',f.workspace,'branch','-M','trunk']);
 await exec('git',['-C',f.workspace,'worktree','add','-qb','feature',linked]);
 const {stdout:gitDir}=await exec('git',['-C',linked,'rev-parse','--absolute-git-dir']);
 f.data.protected_branches=['trunk'];
 f.data.profiles.write={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','edit'],requires_isolated_worktree:true};
 await writeFile(f.policyPath,JSON.stringify(f.data));const policy=await loadPolicy(f.policyPath);
 const previous={GIT_DIR:process.env.GIT_DIR,GIT_WORK_TREE:process.env.GIT_WORK_TREE};
 try {
  process.env.GIT_DIR=gitDir.trim();process.env.GIT_WORK_TREE=f.workspace;
  await assert.rejects(()=>resolveProfile(policy,packet(f.workspace,{profile:'write',actions:['edit'],source_write_authorized:true})),/non-protected/);
 } finally {for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('shutdown during child creation cancels the owned process before returning',async()=>{
 const f=await fixture('slow'),prepared=await prepare(f.policy,packet(f.workspace));
 const {default:childProcess}=await import('node:child_process');
 const {syncBuiltinESMExports}=await import('node:module');
 const original=childProcess.spawn;let injected=false;
 childProcess.spawn=function(command,...args){
  const child=original.call(this,command,...args);
  if(command===f.policy.profiles['codex-readonly'].executable){injected=true;process.emit('SIGTERM');}
  return child;
 };
 syncBuiltinESMExports();
 try {
  const result=await runPrepared(f.policy,'router-test',{approved_digest:prepared.approval_digest,approval_ref:'unit-test-fixture'});
  assert.equal(injected,true);assert.equal(result.status,'cancelled');
 } finally {childProcess.spawn=original;syncBuiltinESMExports();}
});


test('test-only write sandbox cannot accept workspace edits',async()=>{
 const f=await fixture(),linked=path.join(f.root,'test-linked');
 await writeFile(path.join(f.workspace,'source.txt'),'original');
 await exec('git',['-C',f.workspace,'add','source.txt']);
 await exec('git',['-C',f.workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','source']);
 await exec('git',['-C',f.workspace,'worktree','add','-qb','test-scope',linked]);
 f.data.workspace_roots=[f.root];f.data.protected_branches=['main','master'];
 const bin=f.data.profiles['codex-readonly'].executable;
 await writeFile(bin,(await readFile(bin,'utf8')).replace("console.log(JSON.stringify({type:'fixture'", "await fs.writeFile('source.txt','unauthorized');console.log(JSON.stringify({type:'fixture'"));
 f.data.profiles.write={...f.data.profiles['codex-readonly'],sandbox:'workspace-write',actions:['read','test','edit'],requires_isolated_worktree:true};
 await writeFile(f.policyPath,JSON.stringify(f.data));
 const policy=await loadPolicy(f.policyPath),task=packet(linked,{profile:'write',actions:['test'],source_write_authorized:true});
 const prepared=await prepare(policy,task);
 const result=await runPrepared(policy,task.task_id,{approved_digest:prepared.approval_digest,approval_ref:'user approved fixture'});
 assert.equal(result.status,'needs-review');
 assert.equal(result.workspace_changed,true);
 await assert.rejects(()=>acceptResult(policy,task.task_id,{}),/Only a returned/);
});
