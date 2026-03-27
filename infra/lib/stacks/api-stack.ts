import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  environment: string;
  removalPolicy: cdk.RemovalPolicy;
  logRetention: number;
  monitoring: boolean;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const apiFunction = new lambda.Function(this, 'ApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'dist/lambda.handler',
      code: lambda.Code.fromAsset('../', {
        exclude: ['infra', 'tests', 'scripts', '.git', 'node_modules/.cache'],
      }),
      memorySize: 512,
      timeout: cdk.Duration.seconds(29),
      environment: {
        NODE_ENV: props.environment,
        LOG_FORMAT: 'json',
        LOG_LEVEL: props.environment === 'production' ? 'info' : 'debug',
      },
    });

    const logGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/aws/lambda/${apiFunction.functionName}`,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });

    const api = new apigateway.LambdaRestApi(this, 'ApiGateway', {
      handler: apiFunction,
      proxy: true,
      description: `Sc0red API - ${props.environment}`,
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: apiFunction.functionArn,
      description: 'Lambda function ARN',
    });
  }
}
