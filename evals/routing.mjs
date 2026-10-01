#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { routeTask } from '../runtime/execution-router/policy.mjs';
const cases=JSON.parse(await readFile(new URL('./routing-cases.json',import.meta.url),'utf8'));
const results=cases.map(c=>({...c,actual:routeTask(c.facts).route,pass:routeTask(c.facts).route===c.expected}));
console.log(JSON.stringify({kind:'deterministic-contract-not-model-eval',passed:results.filter(r=>r.pass).length,total:results.length,results},null,2));
process.exitCode=results.every(r=>r.pass)?0:1;
