#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHubClient } from '../../runtime/review-remediation/github.mjs';
import { remediate, finalize } from '../../runtime/review-remediation/controller.mjs';
import { DockerExecutor } from '../../runtime/review-remediation/executor.mjs';
import { assertPolicySafety } from '../../runtime/review-remediation/policy.mjs';
import { routeEvent } from '../../runtime/review-remediation/route.mjs';

const {values} = parseArgs({options:{config:{type:'string'},pr:{type:'string'},mode:{type:'string',default:'inspect'},
  image:{type:'string'},'verifier-dir':{type:'string'},output:{type:'string'},'debug-dir':{type:'string'}}});
try {
  if (!values.config) throw new Error('A trusted policy file is required');
  const policy=JSON.parse(await readFile(resolve(values.config),'utf8'));
  assertPolicySafety(policy);
  let signingKeys;
  try {signingKeys=JSON.parse(process.env.REMEDIATION_SIGNING_KEYS??'[]');}
  catch {throw new Error('Invalid REMEDIATION_SIGNING_KEYS JSON');}
  const api=new GitHubClient(process.env.GH_TOKEN,fetch,{signingKeys});
  let result;
  if (values.mode==='route') {
    const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
    const routes=await routeEvent(process.env.GITHUB_EVENT_NAME,event,policy,api);
    result={matrix:{include:routes},hasWork:routes.length>0};
    if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify(result.matrix)}\nhas-work=${result.hasWork}\n`);
  } else {
    if (!/^[1-9][0-9]*$/.test(values.pr??'') || !Number.isSafeInteger(Number(values.pr)) || !['inspect','remediate','finalize'].includes(values.mode))
      throw new Error('Invalid operation or pull request number');
    const number=Number(values.pr);
    const executor=values.mode==='remediate'?new DockerExecutor(api,policy,{image:values.image,
      verifierDir:resolve(values['verifier-dir']??'.'),outputDir:values['debug-dir']}):undefined;
    result=values.mode==='finalize' ? await finalize({api,policy,number}) :
      await remediate({api,policy,executor,number,apply:values.mode==='remediate'});
    if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`eligible=${result.status==='eligible'}\n`);
  }
  if(values.output)await writeFile(values.output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result,null,2));
  if(['failed','agent-failed','agent-timeout'].includes(result.status))process.exitCode=1;
} catch(error) {
  console.error(`Review remediation stopped: ${error.message}`);
  process.exitCode=1;
}
