// 依頼（暗号化）を開いて広告ライブラリを読み、結果を暗号化して /tmp/result.bin に置く。ログには中身を出さない。
// 依頼: base64(iv12 | tag16 | AES-256-GCM(JSON{ script, args, config, capture })) 鍵は ADLIB_KEY（base64・32バイト）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const key = Buffer.from(process.env.ADLIB_KEY || '', 'base64');
if (key.length !== 32) { console.error('鍵が無い'); process.exit(2); }
const open = b64 => { const b = Buffer.from(b64, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); };
const seal = buf => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const e = Buffer.concat([c.update(buf), c.final()]); return Buffer.concat([iv, c.getAuthTag(), e]); };
const job = JSON.parse(open(fs.readFileSync(process.argv[2], 'utf8').trim()).toString('utf8'));
if (!/^adlib_(census|capture)\.js$/.test(job.script)) { console.error('script が違う'); process.exit(2); }
const OUT = '/tmp/out'; fs.mkdirSync(`${OUT}/data`, { recursive: true }); fs.mkdirSync(`${OUT}/images`, { recursive: true });
job.config.outDir = OUT; fs.writeFileSync(`${OUT}/config.json`, JSON.stringify(job.config));
const here = path.dirname(new URL(import.meta.url).pathname);
const run = (s, a) => { const r = spawnSync(process.execPath, [`${here}/${s}`, `${OUT}/config.json`, ...(a || []).map(String)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') }; };
const res = { main: run(job.script, job.args) };
if (job.capture) res.capture = run('adlib_capture.js', job.capture.args);
const files = {};
for (const sub of ['data', 'images']) for (const f of fs.readdirSync(`${OUT}/${sub}`)) files[`${sub}/${f}`] = fs.readFileSync(`${OUT}/${sub}/${f}`).toString('base64');
fs.writeFileSync('/tmp/result.bin', seal(Buffer.from(JSON.stringify({ res, files }))));
console.log(`済み（ファイル ${Object.keys(files).length}・終了 ${res.main.code}${res.capture ? '/' + res.capture.code : ''}）`);
