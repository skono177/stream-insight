CREATE TABLE comment_length_distribution (
  stream_id BIGINT NOT NULL,
  min_length INTEGER NOT NULL,
  max_length INTEGER,
  comment_count BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT pk_comment_length_distribution PRIMARY KEY (stream_id, min_length),
  CONSTRAINT fk_comment_length_distribution_streams FOREIGN KEY (stream_id)
    REFERENCES streams (id) ON DELETE RESTRICT,
  CONSTRAINT ck_comment_length_distribution_min CHECK (min_length >= 0),
  CONSTRAINT ck_comment_length_distribution_range CHECK (
    max_length IS NULL OR max_length >= min_length
  ),
  CONSTRAINT ck_comment_length_distribution_count CHECK (comment_count >= 0)
);
