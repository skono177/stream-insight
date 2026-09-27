CREATE TABLE collection_job_batches (
  collection_job_id BIGINT NOT NULL,
  batch_id TEXT NOT NULL,
  outbox_object_key TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_collection_job_batches PRIMARY KEY (collection_job_id, batch_id),
  CONSTRAINT fk_collection_job_batches_collection_jobs FOREIGN KEY (collection_job_id)
    REFERENCES collection_jobs (id) ON DELETE RESTRICT,
  CONSTRAINT ck_collection_job_batches_batch_id CHECK (
    batch_id ~ '^batch-v1-[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_collection_job_batches_sha256 CHECK (
    payload_sha256 ~ '^[0-9a-f]{64}$'
  )
);
