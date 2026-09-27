CREATE TABLE comment_timeline (
  stream_id BIGINT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  comment_count BIGINT NOT NULL DEFAULT 0,
  comments_per_minute NUMERIC(20,6) NOT NULL DEFAULT 0,
  CONSTRAINT pk_comment_timeline PRIMARY KEY (stream_id, start_at),
  CONSTRAINT fk_comment_timeline_streams FOREIGN KEY (stream_id)
    REFERENCES streams (id) ON DELETE RESTRICT,
  CONSTRAINT ck_comment_timeline_time_range CHECK (end_at > start_at),
  CONSTRAINT ck_comment_timeline_count CHECK (comment_count >= 0),
  CONSTRAINT ck_comment_timeline_velocity CHECK (comments_per_minute >= 0)
);
