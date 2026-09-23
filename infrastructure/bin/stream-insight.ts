import { App, Tags } from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';
import { BackendStack } from '../lib/backend-stack';
import { FrontendStack } from '../lib/frontend-stack';

const app = new App();
const environment = app.node.tryGetContext('environment') as string;

if (environment !== 'dev') {
  throw new Error(`Unsupported environment: ${environment}`);
}

Tags.of(app).add('Project', 'stream-insight');
Tags.of(app).add('Environment', environment);
Tags.of(app).add('ManagedBy', 'cdk');

new NetworkStack(app, `stream-insight-${environment}-network`);
new StorageStack(app, `stream-insight-${environment}-storage`);
new BackendStack(app, `stream-insight-${environment}-backend`);
new FrontendStack(app, `stream-insight-${environment}-frontend`);
