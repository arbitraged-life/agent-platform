import { mkdir, rmdir, writeFile, readFile, rename, appendFile, rm, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateTask, taskId, digest, contained, resolveProfile, workspaceFingerprint, doctorProfile, cleanEnvironment, exec, executableIdentity, VERSION } from './policy.mjs';
const now=()=>new Date().toISOString();
const runDir=(policy,id)=>path.join(policy.state_dir,'runs',taskId(id));
async function json(filename,value) { const temp=filename+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,filename); }
const readJson=async filename=>JSON.parse(await readFile(filename,'utf8'));
async function event(dir,type,metadata={}) { await appendFile(path.join(dir,'events.jsonl'),JSON.stringify({at:now(),type,...metadata})+'\n',{mode:0o600}); }
function renderHandoff(task) { const id=task.task_id,workspace=task.workspace; return `# Handoff: ${id}\n\nProject: ${task.project}\nProfile: ${task.profile}\nWorkspace: ${workspace}\nActions: ${task.actions.join(', ')}\nReason: ${task.delegation_reason}: ${task.delegation_detail}\n\n## Objective\n${task.objective}\n\n## Acceptance criteria\n${task.acceptance_criteria.map(c=>'- '+c).join('\n')}\n\n## References\n${task.references.map(r=>'- '+r).join('\n')}\n\n## Boundaries\nWork only on this task. Do not launch another agent, install dependencies, commit, push, deploy, send messages, access unrelated personal files, change permissions, or spend additional API money. Stop and report a blocker when broader authority is needed. Read the applicable repository instructions. Return a factual summary, changed paths, commands and outcomes, and unresolved issues. Do not claim independent acceptance.\n\nThe launch adapter does not inherit ChatGPT connectors or hidden conversation context. Model-provider access is separate from task network permissions.\n`; }
const qHelper=fileURLToPath(new URL('../../skills/q-first-pr-review/scripts/triage.py',import.meta.url));
export function validateReviewSnapshot(review,snapshot) {
 if(!snapshot || typeof snapshot!=='object' || snapshot.repository!==review.repository || snapshot.pr!==review.pr
  || snapshot.head_sha!==review.head_sha || snapshot.q_review_covers_head!==true)
  throw new Error('Q-first review does not cover the exact PR head');
 if(snapshot.state!=='OPEN' || snapshot.q_review_observed!==true || snapshot.review_history_truncated!==false
  || snapshot.q_review_body_list_truncated===true)
  throw new Error('Q-first review coverage is incomplete');
 const findings=snapshot.findings,bodies=snapshot.q_review_bodies_unverified;
 if(!Array.isArray(findings) || !Array.isArray(bodies) || findings.length>100 || bodies.length>20
  || snapshot.q_review_body_count!==bodies.length)
  throw new Error('Q-first review findings are incomplete');
 const accepted=review.acceptance.findings;
 if(accepted.length!==findings.length || findings.some(f=>!f || typeof f.thread_id!=='string' || !f.thread_id)
  || new Set(findings.map(f=>f.thread_id)).size!==findings.length
  || accepted.some(f=>!f || typeof f!=='object' || Array.isArray(f)
   || Object.keys(f).sort().join(',')!=='disposition,evidence,thread_id'
   || typeof f.thread_id!=='string' || !['fixed','not-actionable','escalate'].includes(f.disposition)
   || typeof f.evidence!=='string' || !f.evidence.trim() || f.evidence.length>2000)
  || new Set(accepted.map(f=>f.thread_id)).size!==accepted.length
  || findings.some(f=>!accepted.some(a=>a.thread_id===f.thread_id)))
  throw new Error('Each active Q finding requires independent acceptance evidence');
 const bodyEvidence=review.acceptance.review_bodies;
 if(bodyEvidence.length!==bodies.length || bodyEvidence.some((entry,index)=>!entry
  || typeof entry!=='object' || Array.isArray(entry)
  || Object.keys(entry).sort().join(',')!=='evidence,index'
  || entry.index!==index || typeof entry.evidence!=='string'
  || !entry.evidence.trim() || entry.evidence.length>2000))
  throw new Error('Each Q review body requires independent acceptance evidence');
 return digest(snapshot);
}
async function reviewSnapshot(policy,task) {
 if(task.review_context.kind==='general')return null;
 const tools=policy.review_tools;
 if(!tools)throw new Error('PR review requires pinned review_tools executables');
 for(const tool of [tools.python,tools.gh]) {
  const current=await executableIdentity({adapter:'codex',executable:tool.path});
  if(digest(current)!==digest(tool))throw new Error('Pinned Q-first review executable changed; prepare a new handoff');
 }
 const env={PATH:'/usr/bin:/bin',LANG:process.env.LANG??'C',HOME:process.env.HOME??''};
 for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GH_HOST','GH_CONFIG_DIR','XDG_CONFIG_HOME'])
  if(process.env[key])env[key]=process.env[key];
 let stdout;
 try {
  ({stdout}=await exec(tools.python.path,['-I',qHelper,'--repo',task.review_context.repository,
   '--pr',String(task.review_context.pr),'--gh-bin',tools.gh.path],
   {timeout:65000,maxBuffer:2_000_000,env}));
 } catch {
  throw new Error('Q-first review snapshot unavailable; do not dispatch another reviewer');
 }
 let response;
 try{response=JSON.parse(stdout);}catch{throw new Error('Q-first review snapshot malformed; do not dispatch another reviewer');}
 return digest({snapshot:validateReviewSnapshot(task.review_context,response),helper:digest(await readFile(qHelper))});
}
export async function prepare(policy,input) {
 const task=validateTask(input);const {workspace,profile}=await resolveProfile(policy,task); task.workspace=workspace;
 const reviewSnapshotDigest=await reviewSnapshot(policy,task);
 if(contained(workspace,policy.state_dir)) await mkdir(path.dirname(policy.state_dir),{recursive:true,mode:0o700});
 const fingerprint=await workspaceFingerprint(workspace,policy.state_dir),executable=await executableIdentity(profile),id=task.task_id;
 if(task.review_context.kind==='pr-review' && fingerprint.head!==task.review_context.head_sha)
  throw new Error('PR review head differs from workspace HEAD; do not dispatch unreviewed code');
 await mkdir(path.join(policy.state_dir,'runs'),{recursive:true,mode:0o700});
 const dir=runDir(policy,id);
 try{await mkdir(dir,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('Task already exists; inspect it or use a new task_id');throw e;}
 const prepared={router_version:VERSION,status:'prepared',task_id:id,project:task.project,created_at:now(),expires_at:new Date(Date.now()+86400000).toISOString(),policy_digest:policy.config_digest,workspace_fingerprint:fingerprint,packet_digest:digest(task),review_snapshot_digest:reviewSnapshotDigest,executable_identity:executable,profile:task.profile,verified:false};
 prepared.approval_digest=digest({router_version:VERSION,packet:task,policy:policy.config_digest,workspace:fingerprint,executable,review_snapshot_digest:reviewSnapshotDigest,expires_at:prepared.expires_at});
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
 if(state.router_version!==VERSION || state.approval_digest!==digest({router_version:VERSION,packet:task,policy:state.policy_digest,workspace:state.workspace_fingerprint,executable:state.executable_identity,review_snapshot_digest:state.review_snapshot_digest,expires_at:state.expires_at}))throw new Error('Prepared router version or approval changed; prepare a new handoff');
 const {profile,workspace}=await resolveProfile(policy,task);
 const executable=await executableIdentity(profile);
 if(digest(executable)!==digest(state.executable_identity))throw new Error('Prepared executable changed; prepare a new handoff');
 const input=await readFile(path.join(dir,'HANDOFF.md'),'utf8');
 if(input!==renderHandoff(task))throw new Error('Rendered handoff changed; prepare a new handoff');
 if(profile.adapter!=='codex')throw new Error('Handoff-only profile: launch in the selected agent after approval');
 if((await workspaceFingerprint(workspace,policy.state_dir)).digest!==state.workspace_fingerprint.digest)throw new Error('Prepared workspace changed; prepare a new handoff');
 if(task.review_context.kind==='pr-review' && state.workspace_fingerprint.head!==task.review_context.head_sha)
  throw new Error('PR review head differs from workspace HEAD; prepare a new handoff');
 if((await reviewSnapshot(policy,task))!==state.review_snapshot_digest)throw new Error('Q-first review changed before dispatch; prepare a new handoff');
 await doctorProfile(profile);
 await mkdir(path.join(policy.state_dir,'locks'),{recursive:true,mode:0o700});
 const lock=path.join(policy.state_dir,'locks',digest(workspace));
 try{await mkdir(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('Workspace already has a run or stale lock; inspect before recovery');throw e;}
 let child,heartbeat,limit,hardKill,cancelPoll,outputPoll,started=false,closed=false,finalized=false,stopReason=null,buffered=0,ioError=null,keepLock=false;let logChain=Promise.resolve();
 let terminateOwned=()=>{};
 let pendingSignal=false;
 const signalStop=()=>{pendingSignal=true;terminateOwned('cancelled');};
 process.on('SIGTERM',signalStop);process.on('SIGINT',signalStop);
 try {
  // Re-read under the exclusive workspace lock to prevent double submission.
  if((await readJson(path.join(dir,'status.json'))).status!=='prepared')throw new Error('Run is not prepared');
  const finalPath=path.join(dir,'agent-final.txt'),outputLimit=profile.max_output_bytes??10*1024*1024;
  const args=['exec','--ignore-user-config','--sandbox',profile.sandbox,'--ephemeral','--json','--color','never','-c','approval_policy="never"','-c','sandbox_workspace_write.network_access=false','--cd',workspace,'--output-last-message',finalPath,'-'];
  // Recheck the approved branch, workspace and Q evidence under the exclusive lock before recording a launch.
  await resolveProfile(policy,task);
  if((await workspaceFingerprint(workspace,policy.state_dir)).digest!==state.workspace_fingerprint.digest)throw new Error('Prepared workspace changed before launch; prepare a new handoff');
  if((await reviewSnapshot(policy,task))!==state.review_snapshot_digest)throw new Error('Q-first review changed before launch; prepare a new handoff');
  if(Date.parse(state.expires_at)<=Date.now())throw new Error('Prepared approval expired before launch');
  let childError;
  const latestExecutable=await executableIdentity(profile);
  if(digest(latestExecutable)!==digest(state.executable_identity))throw new Error('Prepared executable changed; prepare a new handoff');
  if(pendingSignal)throw new Error('Launch cancelled before child creation');
  const running={...state,status:'running',started_at:now(),heartbeat_at:now(),approval_ref:approval.approval_ref,supervisor_pid:process.pid,verified:false};
  await json(path.join(dir,'status.json'),running);started=true;
  await event(dir,'started',{task_id:id,profile:task.profile,approval_ref:approval.approval_ref});
  child=spawn(latestExecutable.path,args,{cwd:workspace,env:cleanEnvironment(),shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  const finished=new Promise(resolve=>{child.on('error',err=>{closed=true;childError=err;resolve({code:null,signal:null});});child.on('close',(code,signal)=>{closed=true;resolve({code,signal});});});
  const terminate=reason=>{if(closed||finalized||stopReason)return;stopReason=reason;try{stopChild(child);}catch(error){ioError??=error;}hardKill=setTimeout(()=>{try{killChild(child);}catch(error){ioError??=error;}},2000);};
  terminateOwned=terminate;
  if(pendingSignal)terminate('cancelled');
  const log=operation=>{logChain=logChain.then(operation).catch(err=>{ioError=err;if(!stopReason){if(closed)stopReason='failed';else terminate('failed');}});};
  const checkFinalOutput=()=>stat(finalPath).then(info=>{if(buffered+info.size>outputLimit)terminate('output-limit');}).catch(error=>{if(error.code!=='ENOENT'){ioError??=error;terminate('failed');}});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  for(const [stream,filename] of [[child.stdout,'stdout.jsonl'],[child.stderr,'stderr.log']])stream.on('data',chunk=>{buffered+=chunk.length;if(buffered>outputLimit){terminate('output-limit');return;}log(()=>appendFile(path.join(dir,filename),chunk,{mode:0o600}));});
  heartbeat=setInterval(()=>{running.heartbeat_at=now();log(()=>json(path.join(dir,'status.json'),running));},1000);
  limit=setTimeout(()=>terminate('timed-out'),profile.max_seconds*1000);
  cancelPoll=setInterval(()=>{stat(path.join(dir,'cancel.request')).then(()=>terminate('cancelled')).catch(e=>{if(e.code!=='ENOENT')terminate('failed');});},100);
  outputPoll=setInterval(checkFinalOutput,100);
  const outcome=await finished;clearInterval(heartbeat);clearInterval(cancelPoll);clearInterval(outputPoll);clearTimeout(limit);clearTimeout(hardKill);await logChain;
  let finalBytes=0;try{finalBytes=(await stat(finalPath)).size;}catch(error){ioError??=error;if(!stopReason)stopReason='failed';}
  if(buffered+finalBytes>outputLimit&&!stopReason)stopReason='output-limit';
  keepLock=true;const group=await stopRemainingGroup(child);keepLock=!group.stopped;
  let after;try{after=await workspaceFingerprint(workspace,policy.state_dir);}catch{after={digest:null,head:null};}
  const result={...running,status:stopReason??(outcome.code===0?'returned':'failed'),finished_at:now(),exit_code:outcome.code,signal:outcome.signal,verified:false,workspace_after:after,workspace_changed:after.digest!==state.workspace_fingerprint.digest,usage:{tokens:null,cost_usd:null,source:'not-measured'},...((childError||ioError)?{error:(childError||ioError).message}:{})};
  if(result.status==='returned'&&(group.lingering||after.digest===null||(profile.sandbox==='read-only'||!task.actions.includes('edit'))&&result.workspace_changed)){result.status='needs-review';result.warning=keepLock?'Owned process group remains alive; workspace lock retained for inspection.':'Descendants were terminated, fingerprint unavailable, or workspace changed without edit authority; inspect before acceptance.';}
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
function boundedEvidence(input) {
 const keys=['verifier','summary','criteria','artifacts'];
 if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!keys.includes(key)))throw new Error('Invalid verification evidence fields');
 const bounded=(value,max)=>typeof value==='string' && value.length<=max;
 if(!bounded(input.verifier,256) || !bounded(input.summary,8192) || !Array.isArray(input.criteria) || input.criteria.length>100 || !Array.isArray(input.artifacts) || input.artifacts.length>20)throw new Error('Verification evidence exceeds limits');
 const criteria=input.criteria.map(item=>{
  if(!item || typeof item!=='object' || Object.keys(item).some(key=>!['criterion','passed','evidence'].includes(key)) || !bounded(item.criterion,4096) || !bounded(item.evidence,8192) || typeof item.passed!=='boolean')throw new Error('Invalid criterion evidence');
  return {criterion:item.criterion,passed:item.passed,evidence:item.evidence};
 });
 if(input.artifacts.some(file=>!bounded(file,4096)))throw new Error('Invalid evidence artifact path');
 const result={verifier:input.verifier,summary:input.summary,criteria,artifacts:[...input.artifacts]};
 if(Buffer.byteLength(JSON.stringify(result))>65536)throw new Error('Verification evidence exceeds byte limit');
 return result;
}
export async function acceptResult(policy,id,evidence) {
 const dir=runDir(policy,id),lock=path.join(dir,'accept.lock');
 try{await mkdir(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('Acceptance already in progress or stale lock; inspect before recovery');throw e;}
 try {
  const state=await readJson(path.join(dir,'status.json')),task=await readJson(path.join(dir,'packet.json'));
  if(state.status!=='returned')throw new Error('Only a returned run can be accepted');
  if(digest(task)!==state.packet_digest)throw new Error('Packet digest changed; approval invalid');
  evidence=boundedEvidence(evidence);
  if(!evidence || typeof evidence.verifier!=='string' || !evidence.verifier.trim() || typeof evidence.summary!=='string' || !evidence.summary.trim())throw new Error('Controller verification evidence required');
  if(!Array.isArray(evidence.criteria) || evidence.criteria.length!==task.acceptance_criteria.length || !task.acceptance_criteria.every(c=>evidence.criteria.some(e=>e.criterion===c && e.passed===true && typeof e.evidence==='string' && e.evidence.trim())))throw new Error('All acceptance criteria require passing evidence');
  if(!Array.isArray(evidence.artifacts) || evidence.artifacts.length<1 || evidence.artifacts.length>20)throw new Error('At least one inspected artifact is required');
  const artifacts=[];const canonicalDir=await realpath(dir);
  for(const file of evidence.artifacts){const absolute=await realpath(file);if(!contained(canonicalDir,absolute)&&!contained(task.workspace,absolute))throw new Error('Evidence artifact outside run/workspace');const info=await stat(absolute);if(!info.isFile()||info.size>10*1024*1024)throw new Error('Evidence artifact too large or not a regular file');artifacts.push({path:absolute,sha256:digest(await readFile(absolute))});}
  if(state.policy_digest!==policy.config_digest)throw new Error('Prepared policy changed before acceptance');
  await resolveProfile(policy,task);
  const current=await workspaceFingerprint(task.workspace,policy.state_dir);
  if(!state.workspace_after?.digest || current.digest!==state.workspace_after.digest)throw new Error('Workspace changed since return; inspect before accepting');
  const result={...state,status:'verified-complete',verified:true,verification:{...evidence,artifacts,verified_at:now(),trust:'Controller-attested evidence, not cryptographic proof of human approval or independent authorship'}};
  await json(path.join(dir,'status.json'),result);await event(dir,'verified-complete',{task_id:id,verifier:evidence.verifier});return result;
 } finally {await rmdir(lock);}
}
