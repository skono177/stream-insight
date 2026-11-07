import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DataCollectorError, awsErrorName, awsHttpStatus, awsPermanentError,
  isAwsServerError, isAwsThrottling, isAwsTimeout } from './errors';

export interface MessageQueue {
  send(body: string): Promise<void>;
}

export class SqsMessageQueue implements MessageQueue {
  constructor(private readonly client: SQSClient, private readonly queueUrl: string) {}

  async send(body: string): Promise<void> {
    try {
      await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: body }), {
        abortSignal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const name = awsErrorName(error);
      const status = awsHttpStatus(error);
      if (isAwsThrottling(name, status)) {
        throw new DataCollectorError('SQS_TRANSIENT', 'SQS throttled SendMessage', name, status, { cause: error });
      }
      if (isAwsTimeout(name) || isAwsServerError(status) || status === undefined) {
        throw new DataCollectorError('SQS_SEND_OUTCOME_UNKNOWN', 'SQS SendMessage outcome is unknown', name, status, { cause: error });
      }
      throw awsPermanentError('SQS SendMessage failed permanently', name, status, error);
    }
  }
}
