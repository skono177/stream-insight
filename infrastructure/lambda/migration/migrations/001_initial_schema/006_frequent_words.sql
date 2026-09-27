CREATE TABLE frequent_words (
  stream_id BIGINT NOT NULL,
  word TEXT NOT NULL,
  count BIGINT NOT NULL,
  rank INTEGER NOT NULL,
  CONSTRAINT pk_frequent_words PRIMARY KEY (stream_id, word),
  CONSTRAINT uq_frequent_words_stream_id_rank UNIQUE (stream_id, rank)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_frequent_words_streams FOREIGN KEY (stream_id)
    REFERENCES streams (id) ON DELETE RESTRICT,
  CONSTRAINT ck_frequent_words_word CHECK (word <> ''),
  CONSTRAINT ck_frequent_words_count CHECK (count > 0),
  CONSTRAINT ck_frequent_words_rank CHECK (rank > 0)
);
