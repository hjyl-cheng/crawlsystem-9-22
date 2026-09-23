import { writeFileSync, chmodSync } from 'node:fs';
import { RoleSchema, IdSchema } from '@crawlsystem/contracts';
import { issueToken, loadSigningKey } from '@crawlsystem/http/auth';
const [role,subject,workspace,path]=process.argv.slice(2);
if(!path)throw new Error('Usage: token <reader|operator|worker> <subject> <workspace> <output-file>');
const token=await issueToken({role:RoleSchema.parse(role),subject:IdSchema.parse(subject),workspace_id:IdSchema.parse(workspace)},loadSigningKey(),3600);
writeFileSync(path,token+'\n',{mode:0o600});chmodSync(path,0o600);console.log('Token written to the requested private file (expires in 1 hour)');
