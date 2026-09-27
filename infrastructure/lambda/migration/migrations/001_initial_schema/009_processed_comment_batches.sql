CREATE TABLE processed_comment_batches (
  batch_id TEXT NOT NULL,
  stream_id BIGINT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_processed_comment_batches PRIMARY KEY (batch_id),
  CONSTRAINT fk_processed_comment_batches_streams FOREIGN KEY (stream_id)
    REFERENCES streams (id) ON DELETE RESTRICT,
  CONSTRAINT ck_processed_comment_batches_batch_id CHECK (
    batch_id ~ '^batch-v1-[0-9a-f]{64}$'
  )
);
