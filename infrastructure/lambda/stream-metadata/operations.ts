import {
  MarkAnalysisFailedInput,
  MarkAnalysisFailedOutput,
  RegisterBatchesInput,
  RegisterBatchesOutput,
  StartCollectionInput,
  StartCollectionOutput,
  StopCollectionInput,
  StopCollectionOutput,
  StreamMetadataInput,
  StreamMetadataOutput,
} from './contracts';
import { stateConflict } from './errors';
import { sameTimestamp, timestampInstant } from './timestamps';

export interface QueryResult<T> {
  readonly rows: readonly T[];
  readonly rowCount: number | null;
}

export interface SqlExecutor {
  query<T>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

interface ChannelRow { id: string; name: string; url: string }
interface StreamRow {
  id: string; channel_id: string; youtube_video_id: string; youtube_live_chat_id: string;
  title: string; started_at: Date | string; ended_at: Date | string | null; url: string;
}
interface JobRow {
  id: string; stream_id: string; execution_arn: string; collection_started_at: Date | string;
  observation_started_at: Date | string | null; collection_stopped_at: Date | string | null;
  collection_status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  analysis_status: 'PENDING' | 'FINALIZING' | 'COMPLETED' | 'FAILED';
  last_page_token: string | null; collected_comment_count: string; stop_reason: string | null;
  error_code: string | null;
}

const channelUrl = (id: string): string => `https://www.youtube.com/channel/${id}`;
const streamUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;
const sameTime = sameTimestamp;
const idString = (value: unknown): string => String(value);

async function startCollection(db: SqlExecutor, input: StartCollectionInput): Promise<StartCollectionOutput> {
  const expectedChannelUrl = channelUrl(input.stream.youtubeChannelId);
  const insertedChannel = await db.query<ChannelRow>(
    `INSERT INTO channels (youtube_channel_id, name, url)
     VALUES ($1, $2, $3)
     ON CONFLICT (youtube_channel_id) DO NOTHING
     RETURNING id::text, name, url`,
    [input.stream.youtubeChannelId, input.stream.channelName, expectedChannelUrl],
  );
  let channel = insertedChannel.rows[0];
  if (!channel) {
    const existing = await db.query<ChannelRow>(
      `SELECT id::text, name, url FROM channels WHERE youtube_channel_id = $1 FOR UPDATE`,
      [input.stream.youtubeChannelId],
    );
    channel = existing.rows[0];
    if (!channel) throw stateConflict('Channel disappeared during START_COLLECTION');
    if (channel.name !== input.stream.channelName || channel.url !== expectedChannelUrl) {
      await db.query(
        `UPDATE channels SET name = $2, url = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1::bigint`,
        [channel.id, input.stream.channelName, expectedChannelUrl],
      );
    }
  }

  const expectedStreamUrl = streamUrl(input.stream.youtubeVideoId);
  const insertedStream = await db.query<StreamRow>(
    `INSERT INTO streams (youtube_video_id, youtube_live_chat_id, channel_id, title, started_at, url)
     VALUES ($1, $2, $3::bigint, $4, $5::timestamptz, $6)
     ON CONFLICT (youtube_video_id) DO NOTHING
     RETURNING id::text, channel_id::text, youtube_video_id, youtube_live_chat_id, title, started_at, ended_at, url`,
    [input.stream.youtubeVideoId, input.stream.youtubeLiveChatId, channel.id, input.stream.title, input.stream.startedAt, expectedStreamUrl],
  );
  let stream = insertedStream.rows[0];
  if (!stream) {
    const existing = await db.query<StreamRow>(
      `SELECT id::text, channel_id::text, youtube_video_id, youtube_live_chat_id, title, started_at, ended_at, url
       FROM streams WHERE youtube_video_id = $1 FOR UPDATE`,
      [input.stream.youtubeVideoId],
    );
    stream = existing.rows[0];
    if (!stream) throw stateConflict('Stream disappeared during START_COLLECTION');
    if (idString(stream.channel_id) !== channel.id) throw stateConflict('Stream belongs to a different channel');
    if (stream.youtube_live_chat_id !== input.stream.youtubeLiveChatId) throw stateConflict('Stream has a different live chat ID');
    if (stream.title !== input.stream.title || !sameTime(stream.started_at, input.stream.startedAt) || stream.url !== expectedStreamUrl) {
      await db.query(
        `UPDATE streams SET title = $2, started_at = $3::timestamptz, url = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1::bigint`,
        [stream.id, input.stream.title, input.stream.startedAt, expectedStreamUrl],
      );
    }
  }

  const insertedJob = await db.query<JobRow>(
    `INSERT INTO collection_jobs
       (stream_id, execution_arn, collection_started_at, collection_status, analysis_status)
     VALUES ($1::bigint, $2, $3::timestamptz, 'RUNNING', 'PENDING')
     ON CONFLICT DO NOTHING
     RETURNING id::text, stream_id::text, execution_arn, collection_started_at, observation_started_at,
       collection_stopped_at, collection_status, analysis_status, last_page_token,
       collected_comment_count::text, stop_reason, error_code`,
    [stream.id, input.executionArn, input.collectionStartedAt],
  );
  let job = insertedJob.rows[0];
  if (!job) {
    const existing = await db.query<JobRow>(
      `SELECT id::text, stream_id::text, execution_arn, collection_started_at, observation_started_at,
         collection_stopped_at, collection_status, analysis_status, last_page_token,
         collected_comment_count::text, stop_reason, error_code
       FROM collection_jobs WHERE execution_arn = $1 OR stream_id = $2::bigint FOR UPDATE`,
      [input.executionArn, stream.id],
    );
    if (existing.rows.length !== 1) throw stateConflict('Execution ARN or stream is already assigned to another collection job');
    job = existing.rows[0];
    if (idString(job.stream_id) !== stream.id || job.execution_arn !== input.executionArn ||
        !sameTime(job.collection_started_at, input.collectionStartedAt)) {
      throw stateConflict('Collection job does not match START_COLLECTION');
    }
  }
  return { streamId: stream.id, collectionJobId: job.id };
}

async function lockJob(db: SqlExecutor, streamId: string, collectionJobId: string, executionArn: string): Promise<JobRow> {
  const result = await db.query<JobRow>(
    `SELECT id::text, stream_id::text, execution_arn, collection_started_at, observation_started_at,
       collection_stopped_at, collection_status, analysis_status, last_page_token,
       collected_comment_count::text, stop_reason, error_code
     FROM collection_jobs WHERE id = $1::bigint FOR UPDATE`,
    [collectionJobId],
  );
  const job = result.rows[0];
  if (!job || idString(job.stream_id) !== streamId || job.execution_arn !== executionArn) {
    throw stateConflict('Collection job identity does not match the input');
  }
  return job;
}

async function registerBatches(db: SqlExecutor, input: RegisterBatchesInput): Promise<RegisterBatchesOutput> {
  const job = await lockJob(db, input.streamId, input.collectionJobId, input.executionArn);
  if (job.collection_status !== 'RUNNING') throw stateConflict('Batches can only be registered while collection is RUNNING');
  if (job.observation_started_at === null) {
    await db.query(
      `UPDATE collection_jobs SET observation_started_at = $2::timestamptz WHERE id = $1::bigint`,
      [job.id, input.observationStartedAt],
    );
  } else if (!sameTime(job.observation_started_at, input.observationStartedAt)) {
    throw stateConflict('Observation start time does not match the stored value');
  }

  const stream = await db.query<{ started_at: Date | string }>(
    `SELECT started_at FROM streams WHERE id = $1::bigint`, [input.streamId],
  );
  if (!stream.rows[0]) throw stateConflict('Stream does not exist');
  const analysisStartAt = timestampInstant(stream.rows[0].started_at)! > timestampInstant(input.observationStartedAt)!
    ? stream.rows[0].started_at
    : input.observationStartedAt;
  const insertedMetric = await db.query(
    `INSERT INTO stream_metrics (stream_id, analysis_start_at) VALUES ($1::bigint, $2::timestamptz)
     ON CONFLICT (stream_id) DO NOTHING`,
    [input.streamId, analysisStartAt],
  );
  if (insertedMetric.rowCount === 0) {
    const metric = await db.query<{ analysis_start_at: Date | string }>(
      `SELECT analysis_start_at FROM stream_metrics WHERE stream_id = $1::bigint`, [input.streamId],
    );
    if (!metric.rows[0] || !sameTime(metric.rows[0].analysis_start_at, analysisStartAt)) {
      throw stateConflict('Stream metrics do not match the derived analysis start time');
    }
  }

  for (const batch of input.batches) {
    const inserted = await db.query(
      `INSERT INTO collection_job_batches (collection_job_id, batch_id, outbox_object_key, payload_sha256)
       VALUES ($1::bigint, $2, $3, $4) ON CONFLICT (collection_job_id, batch_id) DO NOTHING`,
      [job.id, batch.batchId, batch.outboxObjectKey, batch.payloadSha256],
    );
    if (inserted.rowCount === 0) {
      const existing = await db.query<{ outbox_object_key: string; payload_sha256: string }>(
        `SELECT outbox_object_key, payload_sha256 FROM collection_job_batches
         WHERE collection_job_id = $1::bigint AND batch_id = $2`,
        [job.id, batch.batchId],
      );
      const row = existing.rows[0];
      if (!row || row.outbox_object_key !== batch.outboxObjectKey || row.payload_sha256 !== batch.payloadSha256) {
        throw stateConflict('Batch ID is already registered with different content');
      }
    }
  }
  return { registeredBatchCount: input.batches.length };
}

function terminalMatches(stream: StreamRow, job: JobRow, input: StopCollectionInput): boolean {
  return stream.youtube_video_id === input.youtubeVideoId && stream.title === input.title &&
    sameTime(stream.started_at, input.startedAt) && sameTime(stream.ended_at, input.endedAt) &&
    sameTime(job.collection_stopped_at, input.collectionStoppedAt) && job.collection_status === input.collectionStatus &&
    job.last_page_token === input.lastPageToken && idString(job.collected_comment_count) === input.collectedCommentCount &&
    job.stop_reason === input.stopReason && job.error_code === input.errorCode;
}

async function stopCollection(db: SqlExecutor, input: StopCollectionInput): Promise<StopCollectionOutput> {
  const job = await lockJob(db, input.streamId, input.collectionJobId, input.executionArn);
  const streamResult = await db.query<StreamRow>(
    `SELECT id::text, channel_id::text, youtube_video_id, youtube_live_chat_id, title, started_at, ended_at, url
     FROM streams WHERE id = $1::bigint FOR UPDATE`, [input.streamId],
  );
  const stream = streamResult.rows[0];
  if (!stream) throw stateConflict('Stream does not exist');
  if (stream.youtube_video_id !== input.youtubeVideoId) throw stateConflict('YouTube video ID does not match the stored stream');

  if (job.collection_status !== 'RUNNING') {
    if (terminalMatches(stream, job, input)) {
      return { streamId: input.streamId, collectionJobId: input.collectionJobId,
        collectionStatus: input.collectionStatus, analysisStatus: job.analysis_status === 'FAILED' ? 'FAILED' : 'FINALIZING' };
    }
    const failedRecovery = job.collection_status === 'FAILED' && input.collectionStatus === 'FAILED' &&
      stream.ended_at === null && input.endedAt !== null &&
      stream.youtube_video_id === input.youtubeVideoId && stream.title === input.title && sameTime(stream.started_at, input.startedAt) &&
      sameTime(job.collection_stopped_at, input.collectionStoppedAt) && job.last_page_token === input.lastPageToken &&
      idString(job.collected_comment_count) === input.collectedCommentCount && job.stop_reason === input.stopReason && job.error_code === input.errorCode;
    if (!failedRecovery) throw stateConflict('Terminal collection state does not match the retry');
    await db.query(`UPDATE streams SET ended_at = $2::timestamptz, updated_at = CURRENT_TIMESTAMP WHERE id = $1::bigint`,
      [input.streamId, input.endedAt]);
    return { streamId: input.streamId, collectionJobId: input.collectionJobId,
      collectionStatus: 'FAILED', analysisStatus: job.analysis_status === 'FAILED' ? 'FAILED' : 'FINALIZING' };
  }

  if (stream.ended_at !== null && !sameTime(stream.ended_at, input.endedAt)) {
    throw stateConflict('A non-null stream end time cannot be removed or changed');
  }
  if (input.collectionStatus === 'COMPLETED') {
    if (job.observation_started_at === null) throw stateConflict('COMPLETED requires an observation start time');
    const metric = await db.query(`SELECT stream_id FROM stream_metrics WHERE stream_id = $1::bigint`, [input.streamId]);
    if (metric.rows.length === 0) throw stateConflict('COMPLETED requires stream metrics');
  }
  await db.query(
    `UPDATE streams SET title = $2, started_at = $3::timestamptz, ended_at = $4::timestamptz,
       updated_at = CURRENT_TIMESTAMP WHERE id = $1::bigint`,
    [input.streamId, input.title, input.startedAt, input.endedAt],
  );
  const analysisStatus = input.collectionStatus === 'COMPLETED' ? 'FINALIZING' : 'FAILED';
  await db.query(
    `UPDATE collection_jobs SET collection_stopped_at = $2::timestamptz, collection_status = $3,
       analysis_status = $4, last_page_token = $5, collected_comment_count = $6::bigint,
       stop_reason = $7, error_code = $8 WHERE id = $1::bigint`,
    [job.id, input.collectionStoppedAt, input.collectionStatus, analysisStatus, input.lastPageToken,
      input.collectedCommentCount, input.stopReason, input.errorCode],
  );
  return { streamId: input.streamId, collectionJobId: input.collectionJobId,
    collectionStatus: input.collectionStatus, analysisStatus };
}

async function markAnalysisFailed(db: SqlExecutor, input: MarkAnalysisFailedInput): Promise<MarkAnalysisFailedOutput> {
  const job = await lockJob(db, input.streamId, input.collectionJobId, input.executionArn);
  if (job.collection_status === 'RUNNING') throw stateConflict('Analysis cannot fail while collection is RUNNING');
  if (job.analysis_status === 'COMPLETED') {
    return { streamId: input.streamId, collectionJobId: input.collectionJobId, analysisStatus: 'COMPLETED' };
  }
  if (job.analysis_status !== 'FAILED') {
    await db.query(`UPDATE collection_jobs SET analysis_status = 'FAILED', error_code = $2 WHERE id = $1::bigint`,
      [job.id, input.errorCode]);
  }
  return { streamId: input.streamId, collectionJobId: input.collectionJobId, analysisStatus: 'FAILED' };
}

export async function executeOperation(db: SqlExecutor, input: StreamMetadataInput): Promise<StreamMetadataOutput> {
  switch (input.operation) {
    case 'START_COLLECTION': return startCollection(db, input);
    case 'REGISTER_BATCHES': return registerBatches(db, input);
    case 'STOP_COLLECTION': return stopCollection(db, input);
    case 'MARK_ANALYSIS_FAILED': return markAnalysisFailed(db, input);
  }
}
