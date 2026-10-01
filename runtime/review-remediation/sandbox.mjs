import { spawn } from 'node:child_process';
import { readdir, lstat, readFile, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';

export async function snapshot(root) {
  const files = new Map();
  let size = 0, entries = 0;
  async function visit(relative) {
    for (const name of await readdir(join(root, relative))) {
      if (++entries > 50000) throw new Error('snapshot limit exceeded');
      const path = relative ? `${relative}/${name}` : name;
      const full = join(root,path), stat = await lstat(full);
      if (stat.isSymbolicLink()) files.set(path,{type:'symlink',content:await readlink(full),mode:0});
      else if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) {
        size += stat.size;
        if (size > 200*1024*1024) throw new Error('snapshot limit exceeded');
        const bytes = await readFile(full);
        files.set(path,{type:'file',content:bytes.toString('utf8'),bytes,mode:stat.mode & 0o111,binary:!isUtf8(bytes)});
      } else throw new Error(`special file in snapshot: ${path}`);
    }
  }
  await visit('');
  return files;
}

export function changedFiles(before, after) {
  const changes=[];
  for (const path of new Set([...before.keys(),...after.keys()])) {
    const a=before.get(path), b=after.get(path);
    if (a?.type === b?.type && a?.mode === b?.mode) {
      if (a?.type === 'file' && a.bytes.equals(b.bytes)) continue;
      if (a?.type !== 'file' && a?.content === b?.content) continue;
    }
    if ((a && a.type !== 'file') || (b && b.type !== 'file') || a?.binary || b?.binary ||
        (a && b && a.mode !== b.mode)) throw new Error(`special, binary or mode-only change: ${path}`);
    changes.push({path,type:'file',content:b?.content ?? null});
  }
  return changes;
}

export function runCommand(command,args,{timeoutMs=30000,env={},input='',maxOutput=2*1024*1024,cwd}={}) {
  return new Promise(resolveResult=>{
    const child=spawn(command,args,{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,
      ...(process.env.DOCKER_HOST?{DOCKER_HOST:process.env.DOCKER_HOST}:{}),...env},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',forced=null;
    const stop=code=>{forced=code;child.kill('SIGKILL');};
    const timer=setTimeout(()=>stop(124),timeoutMs);
    child.stdin.on('error',()=>{});
    child.stdout.on('data',data=>{stdout+=data.toString();if(stdout.length>maxOutput)stop(125);});
    child.stderr.on('data',data=>{stderr+=data.toString();if(stderr.length>maxOutput)stop(125);});
    child.on('error',()=>{clearTimeout(timer);resolveResult({code:127,stdout:'',stderr:'command unavailable'});});
    child.on('close',code=>{clearTimeout(timer);resolveResult({code:forced??code??1,stdout:stdout.slice(-maxOutput),stderr:stderr.slice(-maxOutput)});});
    child.stdin.end(input);
  });
}

export function boxArgs(image,root,command,{name,readonly=false,network,verifierDir,env={}}={}) {
  const args=['run','--rm','--init','-i','--name',name,'--read-only','--cap-drop=ALL',
    '--security-opt=no-new-privileges','--pids-limit=256','--memory=2g','--cpus=2',
    '--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,
    '--tmpfs','/tmp:rw,nosuid,nodev,size=512m','-e','HOME=/tmp/home',
    '--mount',`type=bind,src=${resolve(root)},dst=/workspace${readonly?',readonly':''}`];
  if(network)args.push(`--network=${network}`);
  if(verifierDir)args.push('--mount',`type=bind,src=${resolve(verifierDir)},dst=/verifier,readonly`);
  for(const key of Object.keys(env)) {
    if(!/^[A-Z][A-Z0-9_]*$/.test(key))throw new Error('invalid environment name');
    args.push('-e',key);
  }
  return [...args,image,...command];
}

async function removeDockerResource(kind,name) {
  const args=kind==='container'?['rm','--force',name]:['network','rm',name];
  const removed=await runCommand('docker',args,{timeoutMs:15000});
  if(removed.code===0)return;
  // --rm may have removed it already. A daemon error is not proof of absence.
  const listed=await runCommand('docker',[kind,'ls',...(kind==='container'?['--all']:[]),
    '--filter',`name=${name}`,'--format',kind==='container'?'{{.Names}}':'{{.Name}}'],{timeoutMs:15000});
  if(listed.code!==0 || listed.stdout.split(/\r?\n/).includes(name))
    throw new Error(`Docker cleanup could not confirm removal of ${kind} ${name}`);
}

export async function runBox(image,root,command,options={}) {
  const name=`review-remediation-${randomUUID()}`;
  try {
    return await runCommand('docker',boxArgs(image,root,command,{...options,name}),options);
  } finally {
    await removeDockerResource('container',name);
  }
}

/** The agent joins an internal-only network; only a trusted proxy has egress. */
export async function runWithInferenceProxy(image,root,command,{proxyEnvironment,controllerDir,...options}) {
  const id=randomUUID(),network=`review-net-${id}`,proxy=`review-proxy-${id}`;
  const docker=async(args,extra={})=>{
    const result=await runCommand('docker',args,{timeoutMs:30000,...extra});
    if(result.code!==0)throw new Error('Inference network setup failed');
    return result;
  };
  try {
    await docker(['network','create','--internal',network]);
    const args=['run','--rm','-d','--init','--name',proxy,'--read-only','--cap-drop=ALL',
      '--security-opt=no-new-privileges','--pids-limit=64','--memory=256m','--cpus=1',
      '--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--network=bridge',
      '--tmpfs','/tmp:rw,nosuid,nodev,size=64m',
      '--mount',`type=bind,src=${resolve(controllerDir)},dst=/controller,readonly`];
    for(const key of Object.keys(proxyEnvironment))args.push('-e',key);
    await docker([...args,image,'node','/controller/inference-proxy.mjs'],{env:proxyEnvironment});
    await docker(['network','connect','--alias','inference',network,proxy]);
    await docker(['exec',proxy,'node','--input-type=module','-e',
      "for(let i=0;i<10;i++){try{const r=await fetch('http://127.0.0.1:8080/health');if(r.ok)process.exit(0);}catch{}await new Promise(r=>setTimeout(r,200));}process.exit(1);"]);
    return await runBox(image,root,command,{...options,network});
  } finally {
    const failures=[];
    for(const [kind,name] of [['container',proxy],['network',network]]) {
      try { await removeDockerResource(kind,name); } catch(error) { failures.push(error); }
    }
    if(failures.length)throw new AggregateError(failures,'Inference resource cleanup failed');
  }
}
