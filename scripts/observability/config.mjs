#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {validateOpikConfig} from '../../observability/opik.mjs';
try {
  const [command,file,...extra]=process.argv.slice(2);
  if(command!=='validate'||!file||extra.length)throw new Error('Usage: config.mjs validate FILE');
  let document;
  try{document=JSON.parse(await readFile(file,'utf8'));}catch{throw new Error('Cannot read telemetry configuration JSON');}
  validateOpikConfig(document);
  console.log('Telemetry configuration valid.');
} catch(error){console.error(error.message);process.exitCode=1;}
