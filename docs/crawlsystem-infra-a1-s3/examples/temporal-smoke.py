"""Local-only maintenance smoke test. Run behind a kubectl port-forward.
Does not crawl, modify Crawler facts, or replace any business Workflow.
"""
import asyncio
import os
from datetime import timedelta
from pathlib import Path
import uuid
from temporalio import workflow, activity
from temporalio.client import Client
from temporalio.service import TLSConfig
from temporalio.worker import Worker

@activity.defn
async def echo_activity(value: str) -> str:
    return "INFRA_OK:" + value

@workflow.defn
class InfraSmoke:
    @workflow.run
    async def run(self, value: str) -> str:
        return await workflow.execute_activity(echo_activity, value, start_to_close_timeout=timedelta(seconds=15))

async def main() -> None:
    p = Path(__file__).resolve().parents[1] / 'secrets' / 'temporal-smoke'
    client = await Client.connect(os.environ.get('TEMPORAL_ADDRESS', '127.0.0.1:17233'), namespace='crawlsystem', tls=TLSConfig(
        server_root_ca_cert=(p/'ca.crt').read_bytes(),
        client_cert=(p/'tls.crt').read_bytes(),
        client_private_key=(p/'tls.key').read_bytes(),
        domain='temporal-frontend.temporal.svc.cluster.local'))
    queue = 'infra-smoke-' + str(uuid.uuid4())
    async with Worker(client, task_queue=queue, workflows=[InfraSmoke], activities=[echo_activity]):
        result = await asyncio.wait_for(client.execute_workflow(
            InfraSmoke.run, 'A1-S3', id=queue, task_queue=queue,
            execution_timeout=timedelta(seconds=45)), timeout=60)
        assert result == 'INFRA_OK:A1-S3', result
        print(result)

if __name__=='__main__':
    asyncio.run(main())
