import { readFileSync } from 'node:fs';
import { probeProxy } from '@crawlsystem/execution-client/proxy-connect';
const lines = readFileSync(process.argv[2]!, 'utf8').trim().split('\n');
const results = await Promise.all(lines.map(async l => ({ proxy: l, ...(await probeProxy('socks5://' + l, { timeoutMs: 10000 })) })));
for (const r of results) console.log(r.ok ? 'OK  ' : 'FAIL', r.proxy, 'latency_ms' in r ? r.latency_ms + 'ms' : r.error);
