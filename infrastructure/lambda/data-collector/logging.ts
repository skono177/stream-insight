export interface LogFields {
  readonly event: 'operation_succeeded' | 'operation_failed';
  readonly awsRequestId: string;
  readonly operation?: string;
  readonly streamId?: string;
  readonly collectionJobId?: string;
  readonly classification?: string;
  readonly externalReason?: string;
  readonly httpStatus?: number;
  readonly elapsedMs: number;
}

export interface Logger { log(fields: LogFields): void }

export const consoleLogger: Logger = {
  log: (fields) => console.log(JSON.stringify(fields)),
};
