import { readFile, realpath, access, stat, lstat, readlink, opendir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export const VERSION = '1.0.4';
export const exec = promisify(execFile);
const REASONS = new Set(['missing-capability','execution-lifecycle','local-harness','explicit-user-choice']);
const ACTIONS = new Set(['read','edit','test']);
const TASK_FIELDS = new Set(['schema_version','task_id','project','objective','workspace','profile','actions','source_write_authorized','delegation_reason','delegation_detail','acceptance_criteria','references','parent_run_id']);
function check(ok, message) { if (!ok) throw new Error(message); }
function canonical(value) {
 if (Array.isArray(value)) return value.map(canonical);
 if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
export function digest(value) { return createHash('sha256').update(typeof value==='string' || Buffer.isBuffer(value)?value:JSON.stringify(canonical(value))).digest('hex'); }
export function contained(root, target) { const rel=path.relative(root,target); return rel==='' || (!path.isAbsolute(rel) && rel!=='..' && !rel.startsWith(`..${path.sep}`)); }
export function taskId(id) { check(typeof id==='string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(id),'Invalid task_id'); return id; }
function text(value, name, max=12000) { check(typeof value==='string' && value.trim().length>0 && value.length<=max,`Invalid ${name}`); }
function expand(value, base) { text(value,'path',4096); return path.resolve(base, value==='~'?os.homedir():value.startsWith('~/')?path.join(os.homedir(),value.slice(2)):value); }
async function canonicalPath(filename) {
 let parent=path.resolve(filename),tail='';
 for (;;) {
  try {return path.join(await realpath(parent),tail);}
  catch (error) {
   if(error.code!=='ENOENT')throw error;
   const next=path.dirname(parent);
   if(next===parent)throw error;
   tail=path.join(path.basename(parent),tail);parent=next;
  }
 }
}
const gitPathDecoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function decodeGitPath(bytes) {
 try{return gitPathDecoder.decode(bytes);}
 catch{throw new Error('Git paths must be valid UTF-8 for safe fingerprinting');}
}
function nulPaths(bytes) {
 const names=[];let start=0;
 for(let index=0;index<bytes.length;index++)if(bytes[index]===0){if(index>start)names.push(decodeGitPath(bytes.subarray(start,index)));start=index+1;}
 check(start===bytes.length,'Malformed NUL-delimited Git paths');
 return names;
}
async function fileDigest(filename) {
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(filename))hash.update(chunk);
 return hash.digest('hex');
}
export async function executableIdentity(profile) {
 if(profile.adapter!=='codex')return null;
 const filename=await realpath(profile.executable),info=await stat(filename);
 check(info.isFile(),'Codex executable is not a regular file');
 await access(filename,constants.X_OK);
 return {path:filename,sha256:await fileDigest(filename)};
}
async function* trackedEntries(workspace) {
 const child=spawn('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',workspace,'ls-files','--cached','--stage','-z'],{env:cleanEnvironment(),stdio:['ignore','pipe','ignore']});
 let error,remaining=Buffer.alloc(0),timedOut=false;
 child.on('error',e=>{error=e;});
 const completion=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 const timer=setTimeout(()=>{timedOut=true;child.kill();},15000);
 try {
  for await(const chunk of child.stdout) {
   let start=0,index;
   while((index=chunk.indexOf(0,start))!==-1) {
    yield remaining.length?Buffer.concat([remaining,chunk.subarray(start,index)]):chunk.subarray(start,index);
    remaining=Buffer.alloc(0);start=index+1;
   }
   if(start<chunk.length)remaining=Buffer.concat([remaining,chunk.subarray(start)]);
  }
  const exit=await completion;
  check(!error && !timedOut && exit.code===0 && remaining.length===0,'Failed to stream tracked Git metadata');
 } finally {
  clearTimeout(timer);
  if(child.exitCode===null && child.signalCode===null)child.kill();
 }
}
export function routeTask(facts={}) {
 check(facts && typeof facts==='object' && !Array.isArray(facts),'Route facts must be an object');
 for(const key of ['authority_blocked','native_available','local_available'])if(Object.hasOwn(facts,key))check(typeof facts[key]==='boolean',`${key} must be boolean`);
 if (facts.authority_blocked) return {route:'needs-user',reason:'Permission, consent, spending, or safety boundary: do not route around it.'};
 if (facts.local_available && REASONS.has(facts.delegate_reason) && typeof facts.delegate_detail==='string' && facts.delegate_detail.trim()) return {route:'local-agent',reason:facts.delegate_detail};
 if (facts.native_available) return {route:'chatgpt-native',reason:'The owning connected tool can complete the task.'};
 if (facts.local_available) return {route:'chatgpt-local',reason:'Use Desktop Commander directly; code and complexity alone do not require another agent.'};
 return {route:'needs-user',reason:'Discover supported tools, complete independent work, then surface only the remaining capability gap.'};
}
export function validateTask(task) {
 check(task && typeof task==='object' && !Array.isArray(task),'Task must be an object');
 for (const key of Object.keys(task)) check(TASK_FIELDS.has(key),`Unknown task field: ${key}`);
 check(task.schema_version===1,'Unsupported task schema_version'); taskId(task.task_id);
 for (const key of ['project','objective','workspace','profile','delegation_detail']) text(task[key],key);
 check(path.isAbsolute(task.workspace),'workspace must be absolute');
 check(REASONS.has(task.delegation_reason),'Invalid delegation_reason');
 check(Array.isArray(task.actions) && task.actions.length>0 && task.actions.every(a=>ACTIONS.has(a)),'Invalid actions');
 check(typeof task.source_write_authorized==='boolean','source_write_authorized must be boolean');
 if (task.actions.some(a=>a!=='read')) check(task.source_write_authorized,'Explicit source write authorization required for edit/test actions');
 check(Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length>0 && task.acceptance_criteria.length<=20,'Invalid acceptance_criteria');
 task.acceptance_criteria.forEach(c=>text(c,'acceptance criterion',2000));
 check(new Set(task.acceptance_criteria).size===task.acceptance_criteria.length,'Duplicate acceptance criteria');
 check(Array.isArray(task.references) && task.references.length<=30 && task.references.every(r=>typeof r==='string' && r.length<4000),'Invalid references');
 if (task.parent_run_id!==undefined) text(task.parent_run_id,'parent_run_id',200);
 const serialized=JSON.stringify(task);
 check(serialized.length<50000,'Task packet is too large; provide bounded context');
 check(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-|ant-)[A-Za-z0-9_-]{24,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9_.=-]{20,}/.test(serialized),'Potential credential in task packet; remove it');
 return structuredClone(task);
}
export function cleanEnvironment(env=process.env) {
 return Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR','TMP','TEMP','SYSTEMROOT','COMSPEC'].filter(k=>env[k]!==undefined).map(k=>[k,env[k]]));
}
export async function loadPolicy(filename) {
 const raw=JSON.parse(await readFile(filename,'utf8')); const base=path.dirname(path.resolve(filename));
 check(raw.schema_version===1 && typeof raw.policy_version==='string','Unsupported policy version');
 for(const k of Object.keys(raw))check(['schema_version','policy_version','state_dir','workspace_roots','profiles','protected_branches'].includes(k),`Unknown policy setting: ${k}`);
 check(Array.isArray(raw.workspace_roots) && raw.workspace_roots.length>0,'workspace_roots required');
 check(raw.profiles && typeof raw.profiles==='object' && !Array.isArray(raw.profiles),'profiles required');
 if(Object.values(raw.profiles).some(p=>p?.sandbox==='workspace-write'))check(Array.isArray(raw.protected_branches)&&raw.protected_branches.length>0&&raw.protected_branches.every(b=>typeof b==='string'&&b.length>0),'Writable profiles require protected_branches');
 if(raw.protected_branches!==undefined)check(Array.isArray(raw.protected_branches)&&raw.protected_branches.every(b=>typeof b==='string'&&b.length>0),'Invalid protected_branches');
 const roots=await Promise.all(raw.workspace_roots.map(v=>realpath(expand(v,base))));
 const profiles=Object.create(null);
 for (const [name,p] of Object.entries(raw.profiles)) {
  check(p.adapter==='codex' || p.adapter==='manual',`Unsupported adapter: ${name}`);
  check(['read-only','workspace-write'].includes(p.sandbox),`Unsupported sandbox: ${name}`);
  check(Array.isArray(p.actions) && p.actions.length>0 && p.actions.every(a=>ACTIONS.has(a)),`Invalid profile actions: ${name}`);
  check(Number.isInteger(p.max_seconds) && p.max_seconds>=1 && p.max_seconds<=1800,`Invalid max_seconds: ${name}`);
  check(p.sandbox!=='read-only' || p.actions.every(a=>a==='read'),`Read-only profile cannot edit/test: ${name}`);
  check(p.sandbox!=='workspace-write' || p.requires_isolated_worktree===true,`Write profile requires isolated worktree: ${name}`);
  if(p.max_output_bytes!==undefined)check(Number.isInteger(p.max_output_bytes)&&p.max_output_bytes>=1&&p.max_output_bytes<=10*1024*1024,`Invalid max_output_bytes: ${name}`);
  check(p.adapter==='manual' || p.requires_chatgpt_login===true,`Codex requires subscription login: ${name}`);
  for (const k of Object.keys(p)) check(['adapter','executable','sandbox','actions','max_seconds','max_output_bytes','requires_isolated_worktree','requires_chatgpt_login','description'].includes(k),`Unknown profile setting: ${k}`);
  if(p.adapter==='codex')text(p.executable,`executable for Codex profile ${name}`,4096);
  profiles[name]={...p,...(p.executable?{executable:p.adapter==='codex'?await canonicalPath(expand(p.executable,base)):expand(p.executable,base)}:{})};
 }
 const resolved={...raw,source_path:path.resolve(filename),state_dir:await canonicalPath(expand(raw.state_dir,base)),workspace_roots:roots,profiles};
 return {...resolved,config_digest:digest({schema_version:resolved.schema_version,policy_version:resolved.policy_version,state_dir:resolved.state_dir,workspace_roots:roots,profiles,protected_branches:resolved.protected_branches})};
}
export async function resolveProfile(policy, task) {
 validateTask(task); const profile=Object.hasOwn(policy.profiles,task.profile)?policy.profiles[task.profile]:undefined; check(profile,`Unknown profile: ${task.profile}`);
 const workspace=await realpath(task.workspace);
 check(policy.workspace_roots.some(root=>contained(root,workspace)),'workspace is outside allowed roots');
 if(profile.sandbox==='workspace-write')check(!contained(workspace,await canonicalPath(policy.state_dir)),'State directory must be outside a writable worktree');
 if(profile.sandbox==='workspace-write')check(task.source_write_authorized&&task.actions.some(a=>a!=='read'),'Write sandbox requires explicit source write authorization and an edit/test action');
 check(task.actions.every(a=>profile.actions.includes(a)),'Task actions exceed profile');
 const {stdout:top}=await exec('git',['-C',workspace,'rev-parse','--show-toplevel'],{timeout:10000,env:cleanEnvironment()});
 check(await realpath(top.replace(/\r?\n$/,''))===workspace,'workspace must be the repository/worktree root');
 if(profile.requires_isolated_worktree) {
  const {stdout:branch}=await exec('git',['-C',workspace,'branch','--show-current'],{timeout:10000,env:cleanEnvironment()});
  check(branch.replace(/\r?\n$/,'') && !['main','master',...(policy.protected_branches??[])].includes(branch.replace(/\r?\n$/,'')),'Writes require a non-protected feature branch');
  const {stdout:dir}=await exec('git',['-C',workspace,'rev-parse','--git-dir'],{timeout:10000,env:cleanEnvironment()});
  const {stdout:common}=await exec('git',['-C',workspace,'rev-parse','--git-common-dir'],{timeout:10000,env:cleanEnvironment()});
  const {stdout:superproject}=await exec('git',['-C',workspace,'rev-parse','--show-superproject-working-tree'],{timeout:10000,env:cleanEnvironment()});
  check(!superproject.trim() && path.resolve(workspace,dir.replace(/\r?\n$/,''))!==path.resolve(workspace,common.replace(/\r?\n$/,'')),'Writes require an isolated linked worktree, not a submodule');
 }
 return {profile,workspace};
}
export async function workspaceFingerprint(workspace,stateDir) {
 const options={timeout:15000,maxBuffer:4*1024*1024,env:cleanEnvironment(),encoding:'buffer'};
 const commands=[['rev-parse','HEAD'],['ls-files','--others','--exclude-standard','-z'],['ls-files','--others','--ignored','--exclude-standard','-z'],['rev-parse','--symbolic-full-name','HEAD'],['rev-parse','--absolute-git-dir']];
 const output=await Promise.all(commands.map(a=>exec('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',workspace,...a],options).then(r=>r.stdout)));
 const state=stateDir && await canonicalPath(stateDir);
 const protectedState=state && contained(workspace,state)?state:null;
 const stateRelative=protectedState && path.relative(workspace,protectedState);
 const excludedState=stateRelative && await exec('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',workspace,'check-ignore','-q','--',`${stateRelative}${path.sep}`],options).then(()=>protectedState,error=>{if(error.code===1)return null;throw error;});
 const gitMetadata=await canonicalPath(path.join(workspace,'.git'));
 const outsideState=name=>!excludedState || !contained(excludedState,path.resolve(workspace,name));
 const ignored=nulPaths(output[2]).filter(outsideState);
 const untracked=nulPaths(output[1]).filter(outsideState);
 check(untracked.length+ignored.length<=512,'Too many untracked or ignored files; use a smaller worktree');
 const emptyDirs=[],directories=[[workspace,'']];let visitedEntries=0;
 while(directories.length) {
  const [dir,relative]=directories.pop();let hasEntries=false;
  for await(const entry of await opendir(dir,{encoding:'buffer'})) {
   check(++visitedEntries<=100000,'Too many directory entries; use a smaller worktree');
   const name=decodeGitPath(entry.name);
   if(!relative && name==='.git')continue;
   if(!entry.isDirectory()){hasEntries=true;continue;}
   const child=path.join(dir,name);
   if(excludedState && contained(excludedState,child))continue;
   hasEntries=true;
   directories.push([child,path.join(relative,name)]);
  }
  if(relative && !hasEntries)emptyDirs.push(relative);
  check(emptyDirs.length<=512,'Too many empty directories; use a smaller worktree');
 }
 emptyDirs.sort();
 const hashes=[],fingerprintedFiles=new Set(),links=[];
 for(const name of [...untracked,...ignored]) {
  const file=path.join(workspace,name),linkInfo=await lstat(file);
  const target=linkInfo.isSymbolicLink()?await readlink(file):null;
  const resolved=await realpath(file);
  check(contained(workspace,resolved),`Untracked or ignored symlink points outside workspace: ${name}`);
  const info=await stat(file);
  check(info.isFile()&&info.size<=10*1024*1024,`Unsupported untracked or ignored file: ${name}`);
  check(info.nlink===1,`Hard-linked untracked or ignored file: ${name}`);
  if(target!==null)links.push([name,resolved]);
  else fingerprintedFiles.add(resolved);
  hashes.push([name,info.mode&0o111,digest(await readFile(file)),...(target===null?[]:[target,resolved])]);
 }
 const tracked=[];
 // Finish Git transport before file hashing, which must not consume its deadline.
 for await(const entry of trackedEntries(workspace))tracked.push(entry);
 for(let index=0;index<tracked.length;index++) {
  const entry=tracked[index],split=entry.indexOf(9);
  check(split>0,'Malformed tracked Git metadata');
  const mode=entry.subarray(0,split).toString('ascii'),name=decodeGitPath(entry.subarray(split+1));
  check(!mode.startsWith('160000 '),`Submodule worktrees are unsupported: ${name}`);
  const file=path.join(workspace,name);
  let info;try{info=await lstat(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!info){tracked[index]=[mode,name,'missing'];continue;}
  if(info.isSymbolicLink()) {
   const resolved=await realpath(file);
   check(contained(workspace,resolved),`Tracked symlink points outside workspace: ${name}`);
   links.push([name,resolved]);
   tracked[index]=[mode,name,'symlink',await readlink(file)];
  } else {
   check(info.isFile()&&info.size<=10*1024*1024,`Unsupported tracked file: ${name}`);
   check(info.nlink===1,`Hard-linked tracked file: ${name}`);
   const resolved=await realpath(file);
   check(contained(workspace,resolved),`Tracked file points outside workspace: ${name}`);
   fingerprintedFiles.add(resolved);
   tracked[index]=[mode,name,info.mode&0o111,digest(await readFile(file))];
  }
 }
 for(const [name,resolved] of links)check((!protectedState || !contained(protectedState,resolved)) && !contained(gitMetadata,resolved) && fingerprintedFiles.has(resolved),`Symlink target is excluded or not independently fingerprinted: ${name}`);
 const head=output[0].toString('ascii').trim(),ref=output[3].toString('base64'),gitDir=output[4].toString('base64');
 return {head,digest:digest({head,ref,gitDir,tracked,untracked:hashes,emptyDirs})};
}
export async function doctorProfile(profile) {
 check(profile.adapter==='codex','This profile is handoff-only; no validated launch adapter');
 const options={timeout:15000,maxBuffer:1024*1024,env:cleanEnvironment()};
 const {stdout:help}=await exec(profile.executable,['exec','--help'],options);
 for(const flag of ['--ignore-user-config','--sandbox','--json','--ephemeral','--output-last-message']) check(help.includes(flag),`Installed Codex lacks required flag ${flag}`);
 const {stdout,stderr}=await exec(profile.executable,['login','status'],options);
 check(/Logged in using ChatGPT/i.test(stdout+'\n'+stderr),'ChatGPT subscription login required; no API-key fallback');
 return {adapter:'codex',login:'ChatGPT',required_flags:true,sandbox:profile.sandbox};
}
