-- Only for the dedicated infra_smoke database; not production business migrations.
\set ON_ERROR_STOP on
INSERT INTO publication.outbox (id,aggregatetype,aggregateid,type,payload)
VALUES (gen_random_uuid(),'INFRA_TEST','A1-S3','INFRA_READY',
        jsonb_build_object('kind','INFRA_TEST','sent_at',clock_timestamp(),'source','infra_smoke'))
RETURNING id;
