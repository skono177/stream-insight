export type Operation =
  | 'START_COLLECTION'
  | 'REGISTER_BATCHES'
  | 'STOP_COLLECTION'
  | 'MARK_ANALYSIS_FAILED';

export interface StartCollectionInput {
  readonly operation: 'START_COLLECTION';
  readonly executionArn: string;
  readonly collectionStartedAt: string;
  readonly stream: {
    readonly youtubeChannelId: string;
    readonly channelName: string;
    readonly youtubeVideoId: string;
    readonly youtubeLiveChatId: string;
    readonly title: string;
    readonly startedAt: string;
  };
}

export interface BatchDescriptor {
  readonly batchId: string;
  readonly outboxObjectKey: string;
  readonly payloadSha256: string;
}

export interface RegisterBatchesInput {
  readonly operation: 'REGISTER_BATCHES';
  readonly streamId: string;
  readonly collectionJobId: string;
  readonly executionArn: string;
  readonly observationStartedAt: string;
  readonly batches: readonly BatchDescriptor[];
}

export interface StopCollectionInput {
  readonly operation: 'STOP_COLLECTION';
  readonly streamId: string;
  readonly collectionJobId: string;
  readonly executionArn: string;
  readonly youtubeVideoId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly collectionStoppedAt: string;
  readonly collectionStatus: 'COMPLETED' | 'FAILED';
  readonly lastPageToken: string | null;
  readonly collectedCommentCount: string;
  readonly stopReason: string;
  readonly errorCode: string | null;
}

export interface MarkAnalysisFailedInput {
  readonly operation: 'MARK_ANALYSIS_FAILED';
  readonly streamId: string;
  readonly collectionJobId: string;
  readonly executionArn: string;
  readonly errorCode: string;
}

export type StreamMetadataInput =
  | StartCollectionInput
  | RegisterBatchesInput
  | StopCollectionInput
  | MarkAnalysisFailedInput;

export interface StartCollectionOutput {
  readonly streamId: string;
  readonly collectionJobId: string;
}

export interface RegisterBatchesOutput {
  readonly registeredBatchCount: number;
}

export interface StopCollectionOutput {
  readonly streamId: string;
  readonly collectionJobId: string;
  readonly collectionStatus: 'COMPLETED' | 'FAILED';
  readonly analysisStatus: 'FINALIZING' | 'FAILED';
}

export interface MarkAnalysisFailedOutput {
  readonly streamId: string;
  readonly collectionJobId: string;
  readonly analysisStatus: 'FAILED' | 'COMPLETED';
}

export type StreamMetadataOutput =
  | StartCollectionOutput
  | RegisterBatchesOutput
  | StopCollectionOutput
  | MarkAnalysisFailedOutput;
