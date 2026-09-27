CREATE TABLE processed_comments (
  stream_id BIGINT NOT NULL,
  comment_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_processed_comments PRIMARY KEY (stream_id, comment_id),
  CONSTRAINT fk_processed_comments_streams FOREIGN KEY (stream_id)
    REFERENCES streams (id) ON DELETE RESTRICT
);
