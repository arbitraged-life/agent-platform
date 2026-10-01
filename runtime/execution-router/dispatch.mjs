import { mkdir, rmdir, writeFile, readFile, rename, appendFile, rm, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateTask, taskId, digest, contained, resolveProfile, workspaceFingerprint, doctorProfile, cleanEnvironment, exec, executableIdentity, VERSION } from './policy.mjs';
const now=()=>new Date().toISOString();
const runDir=(policy,id)=>path.join(policy.state_dir,'runs',taskId(id));
async function json(filename,value) { const temp=filename+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,filename); }
const readJson=async filename=>JSON.parse(await readFile(filename,'utf8'));
async function event(dir,type,metadata={}) { await appendFile(path.join(dir,'events.jsonl'),JSON.stringify({at:now(),type,...metadata})+'\n',{mode:0o600}); }
function renderHandoff(task) { const id=task.task_id,workspace=task.workspace; return `# Handoff: ${id}\n\nProject: ${task.project}\nProfile: ${task.profile}\nWorkspace: ${workspace}\nActions: ${task.actions.join(', ')}\nReason: ${task.delegation_reason}: ${task.delegation_detail}\n\n## Objective\n${task.objective}\n\n## Acceptance criteria\n${task.acceptance_criteria.map(c=>'- '+c).join('\n')}\n\n## References\n${task.references.map(r=>'- '+r).join('\n')}\n\n## Boundaries\nWork only on this task. Do not launch another agent, install dependencies, commit, push, deploy, send messages, access unrelated personal files, change permissions, or spend additional API money. Stop and report a blocker when broader authority is needed. Read the applicable repository instructions. Return a factual summary, changed paths, commands and outcomes, and unresolved issues. Do not claim independent acceptance.\n\nThe launch adapter does not inherit ChatGPT connectors or hidden conversation context. Model-provider access is separate from task network permissions.\n`; }
export async function prepare(policy,input) {
 const task=validateTask(input);const {workspace,profile}=await resolveProfile(policy,task); task.workspace=workspace;
 if(contained(workspace,policy.state_dir)) await mkdir(path.dirname(policy.state_dir),{recursive:true,mode:0o700});
 const fingerprint=await workspaceFingerprint(workspace,policy.state_dir),executable=await executableIdentity(profile),id=task.task_id;
 await mkdir(path.join(policy.state_dir,'runs'),{recursive:true,mode:0o700});
 const dir=runDir(policy,id);
 try{await mkdir(dir,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('Task already exists; inspect it or use a new task_id');throw e;}
 const prepared={router_version:VERSION,status:'prepared',task_id:id,project:task.project,created_at:now(),expires_at:new Date(Date.now()+86400000).toISOString(),policy_digest:policy.config_digest,workspace_fingerprint:fingerprint,packet_digest:digest(task),executable_identity:executable,profile:task.profile,verified:false};
 prepared.approval_digest=digest({router_version:VERSION,packet:task,policy:policy.config_digest,workspace:fingerprint,executable,expires_at:prepared.expires_at});
 await json(path.join(dir,'packet.json'),task);await json(path.join(dir,'status.json'),prepared);
 const handoff=renderHandoff(task);
 await writeFile(path.join(dir,'HANDOFF.md'),handoff,{mode:0o600});
 await event(dir,'prepared',{task_id:id,project:task.project,profile:task.profile,policy_version:policy.policy_version});
 return {...prepared,handoff_path:path.join(dir,'HANDOFF.md'),handoff_only:profile.adapter==='manual'};
}
export async function inspect(policy,id) {
 const state=await readJson(path.join(runDir(policy,id),'status.json'));
 if(state.status==='running' && Date.now()-Date.parse(state.heartbeat_at??state.started_at)>15000) return {...state,status:'unknown',warning:'Supervisor heartbeat is stale. Do not relaunch automatically; inspect the existing run.'};
 return state;
}
export async function requestCancel(policy,id) {
 const dir=runDir(policy,id),state=await inspect(policy,id);
 if(!['running','unknown'].includes(state.status))throw new Error('Run is not running; no arbitrary PID will be signalled');
 await writeFile(path.join(dir,'cancel.request'),'cancel\n',{mode:0o600});
 await event(dir,'cancel-requested',{task_id:id});return {task_id:id,status:'cancel-requested'};
}
function stopChild(child) { if(!child.pid)return;try {if(process.platform==='win32')child.kill('SIGTERM');else process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;} }
function killChild(child) { if(!child.pid)return;try {if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;} }
function groupAlive(child) {
 if(process.platform==='win32'||!child?.pid)return false;
 try{process.kill(-child.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
}
async function stopRemainingGroup(child) {
 if(!groupAlive(child))return {lingering:false,stopped:true};
 stopChild(child);
 for(let i=0;i<10&&groupAlive(child);i++)await new Promise(resolve=>setTimeout(resolve,100));
 if(groupAlive(child))killChild(child);
 for(let i=0;i<10&&groupAlive(child);i++)await new Promise(resolve=>setTimeout(resolve,100));
 return {lingering:true,stopped:!groupAlive(child)};
}
export async function runPrepared(policy,id,approval={}) {
 if(process.platform==='win32')throw new Error('Windows process-tree supervision is not supported; use a manual handoff');
 const dir=runDir(policy,id);const state=await readJson(path.join(dir,'status.json'));
 if(state.status!=='prepared')throw new Error('Run is not prepared; retries require a new task_id and approval');
 if(!approval.approved_digest || typeof approval.approval_ref!=='string' || approval.approval_ref.trim().length<8)throw new Error('Explicit approval digest and user approval reference required');
 if(state.approval_digest!==approval.approved_digest)throw new Error('Invalid approval digest');
 if(Date.parse(state.expires_at)<=Date.now())throw new Error('Prepared approval expired');
 if(state.policy_digest!==policy.config_digest)throw new Error('Prepared policy changed; prepare a new handoff');
 const task=await readJson(path.join(dir,'packet.json'));
 if(digest(task)!==state.packet_digest)throw new Error('Packet digest changed; approval invalid');
 if(state.router_version!==VERSION || state.approval_digest!==digest({router_version:VERSION,packet:task,policy:state.policy_digest,workspace:state.workspace_fingerprint,executable:state.executable_identity,expires_at:state.expires_at}))throw new Error('Prepared router version or approval changed; prepare a new handoff');
 const {profile,workspace}=await resolveProfile(policy,task);
 const executable=await executableIdentity(profile);
 if(digest(executable)!==digest(state.executable_identity))throw new Error('Prepared executable changed; prepare a new handoff');
 const input=await readFile(path.join(dir,'HANDOFF.md'),'utf8');
 if(input!==renderHandoff(task))throw new Error('Rendered handoff changed; prepare a new handoff');
 if(profile.adapter!=='codex')throw new Error('Handoff-only profile: launch in the selected agent after approval');
 if((await workspaceFingerprint(workspace,policy.state_dir)).digest!==state.workspace_fingerprint.digest)throw new Error('Prepared workspace changed; prepare a new handoff');
 await doctorProfile(profile);
 await mkdir(path.join(policy.state_dir,'locks'),{recursive:true,mode:0o700});
 const lock=path.join(policy.state_dir,'locks',digest(workspace));
 try{await mkdir(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('Workspace already has a run or stale lock; inspect before recovery');throw e;}
 let child,heartbeat,limit,hardKill,cancelPoll,outputPoll,started=false,closed=false,finalized=false,stopReason=null,buffered=0,ioError=null,keepLock=false;let logChain=Promise.resolve();
 let terminateOwned=()=>{};
 const signalStop=()=>terminateOwned('cancelled');
 try {
  // Re-read under the exclusive workspace lock to prevent double submission.
  if((await readJson(path.join(dir,'status.json'))).status!=='prepared')throw new Error('Run is not prepared');
  const finalPath=path.join(dir,'agent-final.txt'),outputLimit=profile.max_output_bytes??10*1024*1024;
  const args=['exec','--ignore-user-config','--sandbox',profile.sandbox,'--ephemeral','--json','--color','never','-c','approval_policy="never"','-c','sandbox_workspace_write.network_access=false','--cd',workspace,'--output-last-message',finalPath,'-'];
  const running={...state,status:'running',started_at:now(),heartbeat_at:now(),approval_ref:approval.approval_ref,supervisor_pid:process.pid,verified:false};
  await json(path.join(dir,'status.json'),running);started=true;
  await event(dir,'started',{task_id:id,profile:task.profile,approval_ref:approval.approval_ref});
  // Doctor can take seconds: bind the exact branch and workspace bytes again under the lock before spawn.
  await resolveProfile(policy,task);
  if((await workspaceFingerprint(workspace,policy.state_dir)).digest!==state.workspace_fingerprint.digest)throw new Error('Prepared workspace changed before launch; prepare a new handoff');
  if(Date.parse(state.expires_at)<=Date.now())throw new Error('Prepared approval expired before launch');
  let childError;
  const latestExecutable=await executableIdentity(profile);
  if(digest(latestExecutable)!==digest(state.executable_identity))throw new Error('Prepared executable changed; prepare a new handoff');
  child=spawn(latestExecutable.path,args,{cwd:workspace,env:cleanEnvironment(),shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  const finished=new Promise(resolve=>{child.on('error',err=>{closed=true;childError=err;resolve({code:null,signal:null});});child.on('close',(code,signal)=>{closed=true;resolve({code,signal});});});
  const terminate=reason=>{if(closed||finalized||stopReason)return;stopReason=reason;try{stopChild(child);}catch(error){ioError??=error;}hardKill=setTimeout(()=>{try{killChild(child);}catch(error){ioError??=error;}},2000);};
  terminateOwned=terminate;
  const log=operation=>{logChain=logChain.then(operation).catch(err=>{ioError=err;if(!stopReason){if(closed)stopReason='failed';else terminate('failed');}});};
  const checkFinalOutput=()=>stat(finalPath).then(info=>{if(buffered+info.size>outputLimit)terminate('output-limit');}).catch(error=>{if(error.code!=='ENOENT'){ioError??=error;terminate('failed');}});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  for(const [stream,filename] of [[child.stdout,'stdout.jsonl'],[child.stderr,'stderr.log']])stream.on('data',chunk=>{buffered+=chunk.length;if(buffered>outputLimit){terminate('output-limit');return;}log(()=>appendFile(path.join(dir,filename),chunk,{mode:0o600}));});
  heartbeat=setInterval(()=>{running.heartbeat_at=now();log(()=>json(path.join(dir,'status.json'),running));},1000);
  limit=setTimeout(()=>terminate('timed-out'),profile.max_seconds*1000);
  cancelPoll=setInterval(()=>{stat(path.join(dir,'cancel.request')).then(()=>terminate('cancelled')).catch(e=>{if(e.code!=='ENOENT')terminate('failed');});},100);
  outputPoll=setInterval(checkFinalOutput,100);
  process.once('SIGTERM',signalStop);process.once('SIGINT',signalStop);
  const outcome=await finished;clearInterval(heartbeat);clearInterval(cancelPoll);clearInterval(outputPoll);clearTimeout(limit);clearTimeout(hardKill);await logChain;
  let finalBytes=0;try{finalBytes=(await stat(finalPath)).size;}catch(error){ioError??=error;if(!stopReason)stopReason='failed';}
  if(buffered+finalBytes>outputLimit&&!stopReason)stopReason='output-limit';
  keepLock=true;const group=await stopRemainingGroup(child);keepLock=!group.stopped;
  let after;try{after=await workspaceFingerprint(workspace,policy.state_dir);}catch{after={digest:null,head:null};}
  const result={...running,status:stopReason??(outcome.code===0?'returned':'failed'),finished_at:now(),exit_code:outcome.code,signal:outcome.signal,verified:false,workspace_after:after,workspace_changed:after.digest!==state.workspace_fingerprint.digest,usage:{tokens:null,cost_usd:null,source:'not-measured'},...((childError||ioError)?{error:(childError||ioError).message}:{})};
  if(result.status==='returned'&&(group.lingering||after.digest===null||profile.sandbox==='read-only'&&result.workspace_changed)){result.status='needs-review';result.warning=keepLock?'Owned process group remains alive; workspace lock retained for inspection.':'Descendants were terminated, fingerprint unavailable, or read-only workspace changed; inspect before acceptance.';}
  await json(path.join(dir,'status.json'),result);await event(dir,'returned',{task_id:id,status:result.status,exit_code:result.exit_code,verified:false});return result;
 } catch(e) {
  finalized=true;
  clearInterval(heartbeat);clearInterval(cancelPoll);clearInterval(outputPoll);clearTimeout(limit);clearTimeout(hardKill);
  await logChain;
  let cleanupError;
  if(child){
   keepLock=true;
   try{keepLock=!(await stopRemainingGroup(child)).stopped;}catch(error){cleanupError=error.message;}
  }
  const status=keepLock?'cleanup-uncertain':'failed';
  if(started){await json(path.join(dir,'status.json'),{...state,status,finished_at:now(),verified:false,error:e.message,lock_retained:keepLock,...(cleanupError?{cleanup_error:cleanupError}:{})});await event(dir,status,{task_id:id,error:e.message,lock_retained:keepLock});}
  throw e;
 } finally {finalized=true;clearInterval(heartbeat);clearInterval(cancelPoll);clearInterval(outputPoll);clearTimeout(limit);clearTimeout(hardKill);process.removeListener('SIGTERM',signalStop);process.removeListener('SIGINT',signalStop);if(!keepLock)await rm(lock,{recursive:true,force:true});}
}
export async function acceptResult(policy,id,evidence) {
 const dir=runDir(policy,id),lock=path.join(dir,'accept.lock');
 try{await mkdir(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('Acceptance already in progress or stale lock; inspect before recovery');throw e;}
 try {
  const state=await readJson(path.join(dir,'status.json')),task=await readJson(path.join(dir,'packet.json'));
  if(state.status!=='returned')throw new Error('Only a returned run can be accepted');
  if(digest(task)!==state.packet_digest)throw new Error('Packet digest changed; approval invalid');
  if(!evidence || typeof evidence.verifier!=='string' || !evidence.verifier.trim() || typeof evidence.summary!=='string' || !evidence.summary.trim())throw new Error('Controller verification evidence required');
  if(!Array.isArray(evidence.criteria) || evidence.criteria.length!==task.acceptance_criteria.length || !task.acceptance_criteria.every(c=>evidence.criteria.some(e=>e.criterion===c && e.passed===true && typeof e.evidence==='string' && e.evidence.trim())))throw new Error('All acceptance criteria require passing evidence');
  if(!Array.isArray(evidence.artifacts) || evidence.artifacts.length<1 || evidence.artifacts.length>20)throw new Error('At least one inspected artifact is required');
  const artifacts=[];const canonicalDir=await realpath(dir);
  for(const file of evidence.artifacts){const absolute=await realpath(file);if(!contained(canonicalDir,absolute)&&!contained(task.workspace,absolute))throw new Error('Evidence artifact outside run/workspace');const info=await stat(absolute);if(!info.isFile()||info.size>10*1024*1024)throw new Error('Evidence artifact too large or not a regular file');artifacts.push({path:absolute,sha256:digest(await readFile(absolute))});}
  const current=await workspaceFingerprint(task.workspace,policy.state_dir);
  if(!state.workspace_after?.digest || current.digest!==state.workspace_after.digest)throw new Error('Workspace changed since return; inspect before accepting');
  const result={...state,status:'verified-complete',verified:true,verification:{...evidence,artifacts,verified_at:now(),trust:'Controller-attested evidence, not cryptographic proof of human approval or independent authorship'}};
  await json(path.join(dir,'status.json'),result);await event(dir,'verified-complete',{task_id:id,verifier:evidence.verifier});return result;
 } finally {await rmdir(lock);}
}
