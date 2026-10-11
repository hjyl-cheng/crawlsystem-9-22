ALTER TABLE control.workers ADD COLUMN desired_mode text NOT NULL DEFAULT 'RUNNING' CHECK (desired_mode IN ('RUNNING','PAUSED','DRAINING'));
ALTER TABLE control.workers ADD COLUMN control_version integer NOT NULL DEFAULT 1;
ALTER TABLE control.workers ADD COLUMN control_reason text;
ALTER TABLE control.workers ADD COLUMN control_changed_at timestamptz;
CREATE TABLE control.worker_routing(workspace_id text PRIMARY KEY,enabled_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE control.worker_plans(
 workspace_id text NOT NULL,worker_id text NOT NULL,plan_id uuid PRIMARY KEY REFERENCES control.plans(plan_id),
 queue_kind text NOT NULL CHECK(queue_kind IN ('OWNED','LEGACY')),assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,worker_id) REFERENCES control.workers(workspace_id,worker_id)
);
CREATE INDEX worker_plans_owner ON control.worker_plans(workspace_id,worker_id);
CREATE TABLE control.worker_commands(
 workspace_id text NOT NULL,command_id uuid NOT NULL,worker_id text NOT NULL,request_hash text NOT NULL,
 version integer NOT NULL,mode text NOT NULL,reason text NOT NULL,operator text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,command_id),FOREIGN KEY(workspace_id,worker_id) REFERENCES control.workers(workspace_id,worker_id)
);
CREATE TABLE control.worker_samples(
 workspace_id text NOT NULL,worker_id text NOT NULL,sampled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 process jsonb NOT NULL,PRIMARY KEY(workspace_id,worker_id,sampled_at),
 FOREIGN KEY(workspace_id,worker_id) REFERENCES control.workers(workspace_id,worker_id)
);
