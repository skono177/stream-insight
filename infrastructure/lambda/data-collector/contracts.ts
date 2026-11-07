export type DataCollectorOperation =
  | 'GET_STREAM_METADATA'
  | 'COLLECT_COMMENTS'
  | 'SEND_REGISTERED_BATCHES'
  | 'GET_FINAL_STREAM_METADATA';

export interface GetStreamMetadataInput {
  readonly operation: 'GET_STREAM_METADATA';
  readonly youtubeVideoId: string;
}

export interface Checkpoint {
  readonly nextPageToken: string | null;
  readonly observationStartedAt: string | null;
  readonly pollingIntervalMillis: number | null;
  readonly collectedCommentCount: string;
}

export interface CollectCommentsInput {
  readonly operation: 'COLLECT_COMMENTS';
  readonly streamId: string;
  readonly collectionJobId: string;
  readonly youtubeVideoId: string;
  readonly youtubeLiveChatId: string;
  readonly streamStartedAt: string;
  readonly checkpoint: Checkpoint;
}

export interface BatchDescriptor {
  readonly batchId: string;
  readonly outboxObjectKey: string;
  readonly payloadSha256: string;
}

export interface PendingPage {
  readonly requestPageToken: string | null;
  readonly responseNextPageToken: string;
  readonly snapshotObjectKey: string;
  readonly snapshotSha256: string;
  readonly observationStartedAt: string;
  readonly pollingIntervalMillis: number;
  readonly offlineAt: string | null;
  readonly collectedCommentCount: string;
  readonly batches: readonly BatchDescriptor[];
}

export interface SendRegisteredBatchesInput {
  readonly operation: 'SEND_REGISTERED_BATCHES';
  readonly streamId: string;
  readonly collectionJobId: string;
  readonly registeredBatchCount: number;
  readonly pendingPage: PendingPage;
}

export interface GetFinalStreamMetadataInput {
  readonly operation: 'GET_FINAL_STREAM_METADATA';
  readonly youtubeVideoId: string;
}

export type DataCollectorInput =
  | GetStreamMetadataInput
  | CollectCommentsInput
  | SendRegisteredBatchesInput
  | GetFinalStreamMetadataInput;

export interface GetStreamMetadataOutput {
  readonly youtubeVideoId: string;
  readonly youtubeChannelId: string;
  readonly channelName: string;
  readonly title: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly youtubeLiveChatId: string | null;
  readonly streamStatus: 'UPCOMING' | 'LIVE' | 'ENDED';
}

export interface CollectCommentsOutput {
  readonly pendingPage: PendingPage;
}

export interface SendRegisteredBatchesOutput {
  readonly sentBatchCount: number;
  readonly offlineAt: string | null;
  readonly checkpoint: Checkpoint;
}

export interface GetFinalStreamMetadataOutput {
  readonly youtubeVideoId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly streamStatus: 'UPCOMING' | 'LIVE' | 'ENDED';
}

export type DataCollectorOutput =
  | GetStreamMetadataOutput
  | CollectCommentsOutput
  | SendRegisteredBatchesOutput
  | GetFinalStreamMetadataOutput;

export interface NormalizedComment {
  readonly commentId: string;
  readonly text: string;
  readonly publishedAt: string;
}

export interface CommentPageSnapshot {
  readonly schemaVersion: 'comment-page-v1';
  readonly streamId: string;
  readonly collectionJobId: string;
  readonly youtubeLiveChatId: string;
  readonly requestPageToken: string | null;
  readonly responseNextPageToken: string;
  readonly observationStartedAt: string;
  readonly pollingIntervalMillis: number;
  readonly offlineAt: string | null;
  readonly comments: readonly NormalizedComment[];
}

export interface CommentBatchPayload {
  readonly schemaVersion: 'comment-batch-v1';
  readonly batchId: string;
  readonly streamId: string;
  readonly collectionJobId: string;
  readonly analysisStartAt: string;
  readonly youtubeVideoId: string;
  readonly comments: readonly NormalizedComment[];
}
