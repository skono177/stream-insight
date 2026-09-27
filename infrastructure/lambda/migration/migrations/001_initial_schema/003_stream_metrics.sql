CREATE TABLE stream_metrics (
  stream_id BIGINT NOT NULL,
  total_comments BIGINT NOT NULL DEFAULT 0,
  average_comment_length NUMERIC(20,6) NOT NULL DEFAULT 0,
  average_comments_per_minute NUMERIC(20,6) NOT NULL DEFAULT 0,
  analysis_start_at TIMESTAMPTZ NOT NULL,
  analysis_end_at TIMESTAMPTZ,
  CONSTRAINT pk_stream_metrics PRIMARY KEY (stream_id),
  CONSTRAINT fk_stream_metrics_streams FOREIGN KEY (stream_id)
    REFERENCES streams (id) ON DELETE RESTRICT,
  CONSTRAINT ck_stream_metrics_total_comments CHECK (total_comments >= 0),
  CONSTRAINT ck_stream_metrics_average_length CHECK (average_comment_length >= 0),
  CONSTRAINT ck_stream_metrics_average_velocity CHECK (average_comments_per_minute >= 0),
  CONSTRAINT ck_stream_metrics_time_range CHECK (
    analysis_end_at IS NULL OR analysis_end_at >= analysis_start_at
  )
);
