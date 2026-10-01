#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadPolicy, routeTask, doctorProfile, VERSION } from '../../runtime/execution-router/policy.mjs';
import { prepare, runPrepared, inspect, requestCancel, acceptResult } from '../../runtime/execution-router/dispatch.mjs';

const HELP = `Execution Router ${VERSION}
Usage: node scripts/execution/router.mjs COMMAND [options]

  route   --facts FILE
  doctor  --policy FILE [--profile NAME]
  prepare --policy FILE --task FILE
  run     --policy FILE --task-id ID --approved-digest HASH --approval-ref TEXT
  status  --policy FILE --task-id ID
  cancel  --policy FILE --task-id ID
  verify  --policy FILE --task-id ID --evidence FILE

Preparation never starts a model. Launch requires an explicit approval
reference bound to the prepared digest. Approval references are audit records,
not an independent authentication mechanism. API-key fallback is disabled.
A returned run is not verified-complete until the controller supplies evidence.
`;
const KEYS = new Set(['policy','profile','facts','task','task-id','approved-digest','approval-ref','evidence']);
function parse(args) {
 const command=args.shift(), options={};
 while(args.length) {
  const flag=args.shift();
  if(!flag.startsWith('--') || !KEYS.has(flag.slice(2))) throw new Error(`Unknown option: ${flag}`);
  const value=args.shift();
  if(!value || value.startsWith('--'))throw new Error(`Value required for ${flag}`);
  if(Object.hasOwn(options,flag.slice(2)))throw new Error(`Duplicate option: ${flag}`);
  options[flag.slice(2)]=value;
 }
 return {command,options};
}
async function load(filename,label) {
 if(!filename)throw new Error(`${label} file required`);
 return JSON.parse(await readFile(filename,'utf8'));
}
async function main() {
 const args=process.argv.slice(2);
 if(args.length===0 || args.includes('--help')){console.log(HELP);return;}
 const {command,options:o}=parse(args);
 if(command==='route'){console.log(JSON.stringify(routeTask(await load(o.facts,'facts')),null,2));return;}
 if(!o.policy)throw new Error('--policy is required');
 const policy=await loadPolicy(o.policy);
 let result;
 switch(command) {
  case 'doctor': {
   const profiles=o.profile?{[o.profile]:policy.profiles[o.profile]}:policy.profiles;
   result={router_version:VERSION,policy_version:policy.policy_version,state_dir:policy.state_dir,profiles:Object.create(null)};
   for(const [name,profile] of Object.entries(profiles)){
    if(!profile)throw new Error(`Unknown profile: ${name}`);
    if(profile.adapter==='manual'){result.profiles[name]={status:'handoff-only'};continue;}
    try{result.profiles[name]={status:'ready',...await doctorProfile(profile)};}
    catch(error){result.profiles[name]={status:'blocked',error:error.message};process.exitCode=2;}
   }
   break;
  }
  case 'prepare': result=await prepare(policy,await load(o.task,'task'));break;
  case 'run': result=await runPrepared(policy,o['task-id'],{approved_digest:o['approved-digest'],approval_ref:o['approval-ref']});break;
  case 'status':result=await inspect(policy,o['task-id']);break;
  case 'cancel':result=await requestCancel(policy,o['task-id']);break;
  case 'verify':result=await acceptResult(policy,o['task-id'],await load(o.evidence,'evidence'));break;
  default:throw new Error(`Unknown command: ${command}`);
 }
 console.log(JSON.stringify(result,null,2));
 if(['failed','timed-out','cancelled','needs-review','output-limit'].includes(result.status))process.exitCode=1;
}
main().catch(error=>{console.error(JSON.stringify({status:'blocked',error:error.message}));process.exitCode=2;});
