CREATE ROLE stream_metadata_user LOGIN;

GRANT rds_iam TO stream_metadata_user;
GRANT CONNECT ON DATABASE stream_insight TO stream_metadata_user;
GRANT USAGE ON SCHEMA public TO stream_metadata_user;

GRANT SELECT, INSERT, UPDATE ON TABLE channels TO stream_metadata_user;
GRANT SELECT, INSERT, UPDATE ON TABLE streams TO stream_metadata_user;
GRANT SELECT, INSERT ON TABLE stream_metrics TO stream_metadata_user;
GRANT SELECT, INSERT, UPDATE ON TABLE collection_jobs TO stream_metadata_user;
GRANT SELECT, INSERT ON TABLE collection_job_batches TO stream_metadata_user;

GRANT USAGE ON SEQUENCE channels_id_seq TO stream_metadata_user;
GRANT USAGE ON SEQUENCE streams_id_seq TO stream_metadata_user;
GRANT USAGE ON SEQUENCE collection_jobs_id_seq TO stream_metadata_user;
