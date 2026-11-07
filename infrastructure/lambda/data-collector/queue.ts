import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DataCollectorError, awsErrorCode, awsErrorName, awsHttpStatus, awsPermanentError,
  isAwsServerError, isAwsThrottling, isAwsTimeout, isAwsTransportError } from './errors';

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
      const reason = awsErrorCode(error) ?? name;
      const status = awsHttpStatus(error);
      if (isAwsThrottling(name, status)) {
        throw new DataCollectorError('SQS_TRANSIENT', 'SQS throttled SendMessage', name, status, { cause: error });
      }
      if (isAwsTimeout(name) || isAwsTransportError(error) || isAwsServerError(status)) {
        throw new DataCollectorError('SQS_SEND_OUTCOME_UNKNOWN', 'SQS SendMessage outcome is unknown', reason, status,
          { cause: error });
      }
      throw awsPermanentError('SQS SendMessage failed permanently', name, status, error);
    }
  }
}
