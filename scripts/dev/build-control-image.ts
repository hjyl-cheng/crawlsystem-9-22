import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
if(git('status','--porcelain'))throw new Error('Commit and review source before building a deployable image');
const revision=git('rev-parse','HEAD');
const base='node:22.22.1-alpine@sha256:92d51e5f20b7ff58faa5a969af1a1cec6cbec3fbff7e0f523242b9b5c85ad887';
const directory=resolve('.runtime',`control-api-image-${revision.slice(0,12)}`);mkdirSync(directory+'/app',{recursive:true});
await build({entryPoints:['apps/control-api/src/main.ts'],outfile:directory+'/app/control-api.mjs',bundle:true,platform:'node',format:'esm',target:'node22',minify:true,
  external:['pg-native'],banner:{js:"import{createRequire}from'node:module';const require=createRequire(import.meta.url);"},define:{'process.env.BUILD_VERSION':JSON.stringify(revision)}});
const bundleHash=createHash('sha256').update(readFileSync(directory+'/app/control-api.mjs')).digest('hex');
const image=`docker.io/crawlsystem/control-api:main-${revision.slice(0,12)}-${bundleHash.slice(0,8)}`;
execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-C',directory,'-cf',directory+'/layer.tar','app'],{stdio:'inherit'});
execFileSync('crane',['append','--platform','linux/amd64','--base',base,'--new_layer',directory+'/layer.tar','--new_tag',image,'--output',directory+'/image.tar'],{stdio:'inherit',timeout:120000});
const metadata={revision,base,image,bundle_sha256:bundleHash,directory};writeFileSync(directory+'/build.json',JSON.stringify(metadata,null,2)+'\n');
writeFileSync('.runtime/latest-control-build.json',JSON.stringify(metadata,null,2)+'\n');console.log(JSON.stringify(metadata,null,2));
