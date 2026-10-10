import { z } from 'zod';
import { IdSchema, type Principal } from '@crawlsystem/contracts';
import { StoreError } from '@crawlsystem/store';
import { issueToken } from './auth.ts';
import { TemporalPermissionSchema, type TemporalTokenIssuer } from './temporal-token.ts';
import { inClusterKubernetes, type KubernetesCall } from './kubernetes.ts';

// Kubernetes workload identity: a Worker Pod presents its kubelet-rotated,
// audience-bound ServiceAccount token; TokenReview proves the ServiceAccount and
// the live Pod/node, and we return a short API token whose subject is that Pod.
// No long-lived API credential is stored in the Worker namespace.
export interface ReviewedWorkload { username:string; pod:string; node:string; }
export type TokenReviewer=(token:string,audience:string)=>Promise<ReviewedWorkload|undefined>;
export interface WorkloadIdentityOptions { reviewer:TokenReviewer; audience:string; serviceAccount:string; workspaceId:string; signingKey:Uint8Array; lifetimeSeconds?:number;
  /** Temporal namespace tokens: ServiceAccount → exact permissions it may receive. */
  temporal?:{issuer:TemporalTokenIssuer; permissions:Record<string,string[]>};
  /** Proxy Manager DaemonSet: receives a `node` credential naming the server (TokenReview node). */
  nodeServiceAccount?:string;
  pipelineServiceAccounts?:Record<string,'parser'|'sink'>; }
const ServiceAccountName=/^system:serviceaccount:[a-z0-9-]+:[a-z0-9-]+$/;

const ServiceAccountToken=/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
export class WorkloadIdentity {
  private active=0;
  readonly lifetime:number;
  constructor(private options:WorkloadIdentityOptions) {
    if(options.nodeServiceAccount!==undefined&&(!ServiceAccountName.test(options.nodeServiceAccount)||options.nodeServiceAccount===options.serviceAccount)) throw new Error('Node service account must be a distinct system:serviceaccount:<namespace>:<name>');
    if(!ServiceAccountName.test(options.serviceAccount)) throw new Error('Workload service account must be system:serviceaccount:<namespace>:<name>');
    if(!/^[a-z0-9.-]{3,80}$/.test(options.audience)) throw new Error('Invalid workload token audience');
    IdSchema.parse(options.workspaceId);
    for(const [account,role] of Object.entries(options.pipelineServiceAccounts??{}))
      if(!ServiceAccountName.test(account)||!['parser','sink'].includes(role)||[options.serviceAccount,options.nodeServiceAccount].includes(account)) throw new Error('Pipeline identity must be a distinct ServiceAccount');
    this.lifetime=options.lifetimeSeconds??900;
    if(!Number.isInteger(this.lifetime)||this.lifetime<60||this.lifetime>3600) throw new Error('Workload token lifetime must be 60..3600 seconds');
    for(const [account,permissions] of Object.entries(options.temporal?.permissions??{}))
      if(!ServiceAccountName.test(account)||!permissions.length||permissions.some(p=>!TemporalPermissionSchema.test(p))) throw new Error('Temporal workload permissions must map ServiceAccounts to <namespace>:read|write|worker');
  }
  private async review(header:string|undefined):Promise<ReviewedWorkload> {
    const match=header&&header.length<=8192?ServiceAccountToken.exec(header):null;
    if(!match) throw new StoreError('UNAUTHENTICATED','A workload identity token is required',401);
    // Each exchange costs one API server call; the route is also network-restricted.
    if(this.active>=4) throw new StoreError('UNAVAILABLE','Workload identity capacity reached',503,true);
    this.active++;
    let reviewed:ReviewedWorkload|undefined;
    try {reviewed=await this.options.reviewer(match[1]!,this.options.audience);}
    catch {throw new StoreError('UNAVAILABLE','Workload identity review is temporarily unavailable',503,true);}
    finally {this.active--;}
    if(!reviewed) throw new StoreError('UNAUTHENTICATED','Workload identity token is invalid',401);
    return reviewed;
  }
  async exchange(header:string|undefined):Promise<{token:string;principal:Principal;server_id:string;expires_in:number}> {
    const reviewed=await this.review(header);
    const role=reviewed.username===this.options.serviceAccount?'worker':this.options.nodeServiceAccount&&reviewed.username===this.options.nodeServiceAccount?'node':this.options.pipelineServiceAccounts?.[reviewed.username];
    if(!role) throw new StoreError('FORBIDDEN','Workload is not an execution Worker or Proxy Manager',403);
    const principal:Principal={subject:IdSchema.parse(reviewed.pod),workspace_id:this.options.workspaceId,role,server_id:IdSchema.parse(reviewed.node)};
    return {token:await issueToken(principal,this.options.signingKey,this.lifetime),principal,server_id:IdSchema.parse(reviewed.node),expires_in:this.lifetime};
  }
  /** Temporal token for a mapped ServiceAccount; subject records ServiceAccount and Pod for Temporal audit. */
  async exchangeTemporal(header:string|undefined):Promise<{token:string;permissions:string[];expires_in:number}> {
    const temporal=this.options.temporal;
    if(!temporal) throw new StoreError('DEPENDENCY_NOT_IMPLEMENTED','Temporal authorization is not configured',503);
    const reviewed=await this.review(header),permissions=temporal.permissions[reviewed.username];
    if(!permissions) throw new StoreError('FORBIDDEN','Workload has no Temporal permissions',403);
    return {token:await temporal.issuer.issue(`${reviewed.username}/${reviewed.pod}`,permissions),permissions,expires_in:temporal.issuer.lifetime};
  }
}

const ReviewSchema=z.object({status:z.object({authenticated:z.boolean().optional(),audiences:z.array(z.string()).optional(),
  user:z.object({username:z.string().optional(),extra:z.record(z.string(),z.array(z.string())).optional()}).optional()})});
// In-cluster TokenReview using the API Pod's own ServiceAccount (RBAC: create tokenreviews only).
export function kubernetesTokenReviewer(call:KubernetesCall=inClusterKubernetes()):TokenReviewer {
  return async (token,audience)=>{
    const response=await call('POST','/apis/authentication.k8s.io/v1/tokenreviews',{apiVersion:'authentication.k8s.io/v1',kind:'TokenReview',spec:{token,audiences:[audience]}});
    if(response.status!==201&&response.status!==200) throw new Error(`TokenReview HTTP ${response.status}`);
    const status=ReviewSchema.parse(response.body).status,extra=status.user?.extra??{};
    const pod=extra['authentication.kubernetes.io/pod-name']?.[0],node=extra['authentication.kubernetes.io/node-name']?.[0];
    // Only Pod-bound tokens for our audience identify a Worker instance.
    if(!status.authenticated||!status.audiences?.includes(audience)||!status.user?.username||!pod||!node) return undefined;
    return {username:status.user.username,pod,node};
  };
}
