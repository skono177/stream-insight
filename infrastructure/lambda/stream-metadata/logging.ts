import { ErrorClassification } from './errors';

export interface SafeLogEntry {
  readonly event: string;
  readonly awsRequestId?: string;
  readonly operation?: string;
  readonly streamId?: string;
  readonly collectionJobId?: string;
  readonly classification?: ErrorClassification;
  readonly postgresCode?: string;
  readonly retryCount?: number;
  readonly elapsedMs?: number;
}

export interface SafeLogger {
  log(entry: SafeLogEntry): void;
}

export const consoleLogger: SafeLogger = {
  log(entry): void {
    console.log(JSON.stringify(entry));
  },
};
