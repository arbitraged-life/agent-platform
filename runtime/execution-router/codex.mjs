import { access, realpath, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

// Only the explicitly validated Codex profile has a launcher. Manual profiles
// remain handoff-only and never acquire an implicit executable.
export const codexAdapter = Object.freeze({
 validateProfile(profile, name) {
  if(profile.requires_chatgpt_login!==true)throw new Error(`Codex requires subscription login: ${name}`);
  if(typeof profile.executable!=='string' || !profile.executable.trim() || profile.executable.length>4096)throw new Error(`Invalid executable for Codex profile ${name}`);
 },
 async executableIdentity(profile) {
  const filename=await realpath(profile.executable),info=await stat(filename);
  if(!info.isFile())throw new Error('Codex executable is not a regular file');
  await access(filename,constants.X_OK);
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(filename))hash.update(chunk);
  return {path:filename,sha256:hash.digest('hex')};
 },
 async doctor(profile, exec, cleanEnvironment) {
  const options={timeout:15000,maxBuffer:1024*1024,env:cleanEnvironment()};
  const {stdout:help}=await exec(profile.executable,['exec','--help'],options);
  for(const flag of ['--ignore-user-config','--sandbox','--json','--ephemeral','--output-last-message'])if(!help.includes(flag))throw new Error(`Installed Codex lacks required flag ${flag}`);
  const {stdout,stderr}=await exec(profile.executable,['login','status'],options);
  if(!/Logged in using ChatGPT/i.test(stdout+'\n'+stderr))throw new Error('ChatGPT subscription login required; no API-key fallback');
  return {adapter:'codex',login:'ChatGPT',required_flags:true,sandbox:profile.sandbox};
 },
 launchArgs(profile, workspace, finalPath) {
  return ['exec','--ignore-user-config','--sandbox',profile.sandbox,'--ephemeral','--json','--color','never','-c','approval_policy="never"','-c','sandbox_workspace_write.network_access=false','--cd',workspace,'--output-last-message',finalPath,'-'];
 }
});
