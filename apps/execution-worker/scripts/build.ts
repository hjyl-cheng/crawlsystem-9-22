import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';
const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)) });
const output = new URL('../dist/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL('workflow-bundle.cjs', output), bundle.code);
console.log('Workflow bundle built; worker host runs with Node 22 + tsx');
