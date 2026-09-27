CREATE TABLE streams (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  youtube_video_id TEXT NOT NULL,
  youtube_live_chat_id TEXT NOT NULL,
  channel_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_streams PRIMARY KEY (id),
  CONSTRAINT uq_streams_youtube_video_id UNIQUE (youtube_video_id),
  CONSTRAINT fk_streams_channels FOREIGN KEY (channel_id)
    REFERENCES channels (id) ON DELETE RESTRICT,
  CONSTRAINT ck_streams_time_range CHECK (ended_at IS NULL OR ended_at >= started_at)
);
