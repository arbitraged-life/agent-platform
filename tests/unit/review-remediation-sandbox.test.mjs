import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, access, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshot, changedFiles, boxArgs, runCommand } from '../../runtime/review-remediation/sandbox.mjs';

test('snapshot records symlinks without reading their targets', async () => {
  const dir=await mkdtemp(join(tmpdir(),'review-snapshot-'));
  try {
    await writeFile(join(dir,'a.txt'),'original');
    await symlink('/does/not/exist',join(dir,'link'));
    const before=await snapshot(dir);
    assert.equal(before.get('link').type,'symlink');
    await writeFile(join(dir,'a.txt'),'fixed');
    const after=await snapshot(dir);
    assert.deepEqual(changedFiles(before,after).map(c=>[c.path,c.content]),[['a.txt','fixed']]);
    after.set('new-link',{type:'symlink',content:'/etc/passwd',mode:0});
    assert.throws(()=>changedFiles(before,after),/special/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('snapshot hashes binary files without decoding and rejects changed bytes', async () => {
  const dir=await mkdtemp(join(tmpdir(),'review-binary-snapshot-'));
  try {
    const file=join(dir,'input.bin');
    await writeFile(file,Buffer.from([0x80]));
    const before=await snapshot(dir);
    await writeFile(file,Buffer.from([0x81]));
    const after=await snapshot(dir);
    assert.notEqual(before.get('input.bin').hash,after.get('input.bin').hash);
    assert.equal(before.get('input.bin').content,undefined);
    assert.equal(after.get('input.bin').bytes,undefined);
    assert.throws(()=>changedFiles(before,after),/binary/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('snapshot bounds all entries, including directories and symlinks, at exactly 50000', async () => {
  const dir=await mkdtemp(join(tmpdir(),'review-snapshot-limit-'));
  try {
    const totalLinks=49998;
    for(let start=0;start<totalLinks;start+=128) {
      await Promise.all(Array.from({length:Math.min(128,totalLinks-start)},(_,offset)=>
        symlink('missing-target',join(dir,`link-${start+offset}`))));
    }
    await mkdir(join(dir,'nested'));
    await writeFile(join(dir,'nested','input.txt'),'ok');
    const atLimit=await snapshot(dir);
    assert.equal(atLimit.size,totalLinks+1);
    assert.equal(atLimit.get('nested/input.txt').content,'ok');
    await mkdir(join(dir,'another-directory'));
    await assert.rejects(()=>snapshot(dir),/snapshot limit exceeded/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('Docker arguments isolate verification and never mount home or Docker socket', () => {
  const args=boxArgs('image:1','/safe/work',['python3','/verifier/check.py'],{name:'run-1',readonly:true,network:'none',verifierDir:'/safe/verifier'});
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--network=none'));
  assert.ok(args.some(x=>x.includes('dst=/workspace,readonly')));
  assert.ok(!args.join(' ').includes('docker.sock'));
  assert.ok(!args.join(' ').includes('GH_TOKEN'));
});
test('process timeout terminates the child rather than reporting success', async () => {
  const result=await runCommand(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeoutMs:100});
  assert.equal(result.code,124);
});

test('archive extraction accepts regular files and rejects traversal', async () => {
  const dir=await mkdtemp(join(tmpdir(),'review-archive-'));
  try {
    for (const [name,expected] of [['root/src/a.txt',0],['root/../../escape',1]]) {
      const archive=join(dir,'input.tar.gz');
      await runCommand('python3',['-c',`import tarfile,io,sys
with tarfile.open(sys.argv[1],'w:gz') as t:
 m=tarfile.TarInfo(sys.argv[2]);m.size=2;t.addfile(m,io.BytesIO(b'ok'))`,archive,name]);
      const result=await runCommand('python3',['runtime/review-remediation/extract-archive.py',archive,join(dir,expected?'bad':'good')]);
      assert.equal(result.code,expected);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('archive rejects links nested below another link without creating outside files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'review-links-'));
  try {
    const archive=join(dir,'input.tar.gz');
    await runCommand('python3',['-c',`import tarfile,sys,os
os.mkdir(sys.argv[2])
with tarfile.open(sys.argv[1],'w:gz') as t:
 for name,target in [('root/escape',sys.argv[2]),('root/escape/child','/etc/passwd')]:
  m=tarfile.TarInfo(name);m.type=tarfile.SYMTYPE;m.linkname=target;t.addfile(m)`,archive,join(dir,'outside')]);
    const result=await runCommand('python3',['runtime/review-remediation/extract-archive.py',archive,join(dir,'out')]);
    assert.equal(result.code,1);
    const files=await snapshot(join(dir,'outside'));assert.equal(files.size,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('archive link parents cannot escape through filesystem case aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-link-case-'));
  try {
    await mkdir(join(dir, 'case-probe'));
    const foldsCase = await access(join(dir, 'CASE-PROBE')).then(() => true, () => false);
    const archive = join(dir, 'input.tar.gz');
    const outside = join(dir, 'outside');
    const generated = await runCommand('python3', ['-c', `import tarfile,sys,os
os.mkdir(sys.argv[2])
with tarfile.open(sys.argv[1],'w:gz') as t:
 for name,target in [('root/escape',sys.argv[2]),('root/ESCAPE/child','/etc/passwd')]:
  m=tarfile.TarInfo(name);m.type=tarfile.SYMTYPE;m.linkname=target;t.addfile(m)`, archive, outside]);
    assert.equal(generated.code, 0);
    const result = await runCommand('python3', ['runtime/review-remediation/extract-archive.py', archive, join(dir, 'out')]);
    assert.equal((await snapshot(outside)).size, 0, 'extraction must not create a link outside its root');
    assert.equal(result.code, foldsCase ? 1 : 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('combined subprocess output is capped in bytes',async()=>{
 const result=await runCommand(process.execPath,['-e',"process.stdout.write('€'.repeat(20));process.stderr.write('€'.repeat(20))"],{maxOutput:100});
 assert.equal(result.code,125);
 assert.ok(result.stdout.length+result.stderr.length<=100);
});

test('command timeout terminates a forked descendant that would outlive its parent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-process-group-')),marker=join(root,'escaped');
 try {
  const descendant=`process.on('SIGTERM',()=>{});process.send('ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),1500);`;
  const parent=`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{console.log('ready');setInterval(()=>{},1000);});`;
  const result=await runCommand(process.execPath,['-e',parent],{timeoutMs:1000});
  assert.equal(result.code,124);assert.match(result.stdout,/ready/);
  await new Promise(resolve=>setTimeout(resolve,1600));
  await assert.rejects(()=>access(marker));
 } finally {await rm(root,{recursive:true,force:true});}
});

test('completed group termination is not repeated against an exited group',async()=>{
 const original=process.kill;let groupKills=0;
 process.kill=function(pid,signal){
  if(pid<0 && signal==='SIGKILL' && ++groupKills>1)throw Object.assign(new Error('already terminated group'),{code:'EPERM'});
  return original.call(this,pid,signal);
 };
 try {
  const result=await runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:150});
  assert.equal(result.code,124);assert.equal(groupKills,1);
 } finally {process.kill=original;}
});


test('baseline retains only hashes and final snapshots decode only changed text',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'review-hash-snapshot-'));
  try {
    await writeFile(join(dir,'same.txt'),'unchanged');
    await writeFile(join(dir,'changed.txt'),'before');
    await writeFile(join(dir,'binary.bin'),Buffer.from([0x80]));
    const before=await snapshot(dir,{includeContent:false});
    for(const entry of before.values()) {
      assert.equal(entry.bytes,undefined);assert.equal(entry.content,undefined);
      assert.match(entry.hash,/^[a-f0-9]{64}$/);
    }
    await writeFile(join(dir,'changed.txt'),'after');
    const after=await snapshot(dir,{baseline:before});
    assert.equal(after.get('same.txt').content,undefined);
    assert.deepEqual(changedFiles(before,after),[{path:'changed.txt',type:'file',content:'after'}]);
    delete after.get('changed.txt').content;
    assert.throws(()=>changedFiles(before,after),/Missing changed file content/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('archive rejects actual case and Unicode aliases in implicit directory parents',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'review-directory-alias-'));
  try {
    for(const [index,names] of [['case',['Mixed','MIXED']],['unicode',['caf\u00e9','cafe\u0301']]]) {
      const probe=join(dir,index);await mkdir(probe);await mkdir(join(probe,names[0]));
      const aliases=await access(join(probe,names[1])).then(()=>true,()=>false);
      const archive=join(dir,`${index}.tar.gz`);
      const made=await runCommand('python3',['-c',`import tarfile,io,sys
with tarfile.open(sys.argv[1],'w:gz') as t:
 for parent,leaf in [(sys.argv[2],'a'),(sys.argv[3],'b')]:
  m=tarfile.TarInfo('root/'+parent+'/'+leaf);m.size=2;t.addfile(m,io.BytesIO(b'ok'))`,archive,...names]);
      assert.equal(made.code,0);
      const result=await runCommand('python3',['runtime/review-remediation/extract-archive.py',archive,join(dir,index+'-out')]);
      assert.equal(result.code,aliases?1:0);
    }
    const archive=join(dir,'same.tar.gz');
    await runCommand('python3',['-c',`import tarfile,io,sys
with tarfile.open(sys.argv[1],'w:gz') as t:
 m=tarfile.TarInfo('root/src/a');m.size=2;t.addfile(m,io.BytesIO(b'ok'))
 m=tarfile.TarInfo('root/src');m.type=tarfile.DIRTYPE;t.addfile(m)`,archive]);
    assert.equal((await runCommand('python3',['runtime/review-remediation/extract-archive.py',archive,join(dir,'same-out')])).code,0);
  } finally {await rm(dir,{recursive:true,force:true});}
});
