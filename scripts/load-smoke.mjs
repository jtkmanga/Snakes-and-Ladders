#!/usr/bin/env node
/** Bounded *HTTP-only* read-only load smoke; never claims 10K multiplayer capacity. */
import {setTimeout as delay} from 'node:timers/promises';
import {stagingBase, readJson, checkHealth} from '../src/contracts.mjs';

function bounded(name, value, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

const base = stagingBase(process.env.STAGING_BASE_URL);
const seconds = bounded('SECONDS',process.env.SECONDS ?? 3,1,15);
const rps = bounded('RPS',process.env.RPS ?? 4,1,10);
const concurrency = bounded('CONCURRENCY',process.env.CONCURRENCY ?? 2,1,10);
const requests = seconds*rps;
if (requests > 150) throw Error('Refusing excessive load');

let index=0, failures=0;
const times=[];
const start=Date.now();
async function worker() {
  for (;;) {
    const i=index++;
    if (i >= requests) return;
    const scheduled=start+Math.floor(i*1000/rps);
    if (Date.now()<scheduled) await delay(scheduled-Date.now());
    const before=Date.now();
    try {
      const {status,body}=await readJson(base,'/api/health',{timeout:8000});
      if (status!==200) throw Error('non-200');
      checkHealth(body);
      times.push(Date.now()-before);
    } catch {
      failures++;
    }
  }
}
await Promise.all(Array.from({length:concurrency},worker));
const success=requests-failures;
const sorted=times.sort((a,b)=>a-b);
const p95=sorted.length?sorted[Math.ceil(sorted.length*0.95)-1]:null;
console.log(JSON.stringify({target:base,mode:'read-only-http-smoke',requests,success,failures,seconds,rps,concurrency,p95_ms:p95}));
if (failures) process.exitCode=1;
