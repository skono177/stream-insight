CREATE TABLE collection_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  stream_id BIGINT NOT NULL,
  execution_arn TEXT NOT NULL,
  collection_started_at TIMESTAMPTZ NOT NULL,
  observation_started_at TIMESTAMPTZ,
  collection_stopped_at TIMESTAMPTZ,
  collection_status TEXT NOT NULL,
  analysis_status TEXT NOT NULL,
  last_page_token TEXT,
  collected_comment_count BIGINT NOT NULL DEFAULT 0,
  stop_reason TEXT,
  error_code TEXT,
  analysis_finalized_at TIMESTAMPTZ,
  CONSTRAINT pk_collection_jobs PRIMARY KEY (id),
  CONSTRAINT uq_collection_jobs_stream_id UNIQUE (stream_id),
  CONSTRAINT uq_collection_jobs_execution_arn UNIQUE (execution_arn),
  CONSTRAINT fk_collection_jobs_streams FOREIGN KEY (stream_id)
    REFERENCES streams (id) ON DELETE RESTRICT,
  CONSTRAINT ck_collection_jobs_collection_status CHECK (
    collection_status IN ('RUNNING', 'COMPLETED', 'FAILED')
  ),
  CONSTRAINT ck_collection_jobs_analysis_status CHECK (
    analysis_status IN ('PENDING', 'FINALIZING', 'COMPLETED', 'FAILED')
  ),
  CONSTRAINT ck_collection_jobs_collected_count CHECK (collected_comment_count >= 0),
  CONSTRAINT ck_collection_jobs_stop_time CHECK (
    collection_stopped_at IS NULL OR collection_stopped_at >= collection_started_at
  )
);
