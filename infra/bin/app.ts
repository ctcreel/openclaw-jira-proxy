import * as cdk from 'aws-cdk-lib';

import { ApiStack } from '../lib/stacks/api-stack';

const app = new cdk.App();

const environment = app.node.tryGetContext('environment') ?? process.env.CDK_ENVIRONMENT ?? 'development';

const environmentConfig: Record<string, {
  account: string;
  region: string;
  removalPolicy: cdk.RemovalPolicy;
  logRetention: number;
  monitoring: boolean;
}> = {
  development: {
    account: process.env.AWS_ACCOUNT_ID ?? '370943307011',
    region: process.env.AWS_REGION ?? 'us-east-1',
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    logRetention: 7,
    monitoring: false,
  },
  testing: {
    account: process.env.AWS_ACCOUNT_ID ?? '470870054614',
    region: process.env.AWS_REGION ?? 'us-east-1',
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    logRetention: 14,
    monitoring: true,
  },
  demo: {
    account: process.env.AWS_ACCOUNT_ID ?? '120520853304',
    region: process.env.AWS_REGION ?? 'us-east-1',
    removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    logRetention: 30,
    monitoring: true,
  },
  production: {
    account: process.env.AWS_ACCOUNT_ID ?? '164995166092',
    region: process.env.AWS_REGION ?? 'us-east-1',
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    logRetention: 90,
    monitoring: true,
  },
};

const config = environmentConfig[environment] ?? environmentConfig.development;

new ApiStack(app, `Sc0red-Api-${environment}`, {
  env: { account: config!.account, region: config!.region },
  environment,
  ...config!,
  tags: {
    Project: 'Sc0red',
    ManagedBy: 'CDK',
    Environment: environment,
  },
});
