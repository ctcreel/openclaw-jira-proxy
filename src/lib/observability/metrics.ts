export const MetricUnit = {
  COUNT: 'Count',
  COUNT_PER_SECOND: 'Count/Second',
  SECONDS: 'Seconds',
  MILLISECONDS: 'Milliseconds',
  MICROSECONDS: 'Microseconds',
  BYTES: 'Bytes',
  KILOBYTES: 'Kilobytes',
  MEGABYTES: 'Megabytes',
  GIGABYTES: 'Gigabytes',
  BYTES_PER_SECOND: 'Bytes/Second',
  KILOBYTES_PER_SECOND: 'Kilobytes/Second',
  PERCENT: 'Percent',
  NONE: 'None',
} as const;

export type MetricUnit = (typeof MetricUnit)[keyof typeof MetricUnit];

const DEFAULT_NAMESPACE = 'Sc0red';

export interface Metric {
  name: string;
  value: number;
  unit: MetricUnit;
  dimensions: Record<string, string>;
  timestamp: Date;
}

export function createMetric(
  name: string,
  value: number,
  options?: {
    unit?: MetricUnit;
    dimensions?: Record<string, string>;
  },
): Metric {
  return {
    name,
    value,
    unit: options?.unit ?? MetricUnit.COUNT,
    dimensions: options?.dimensions ?? {},
    timestamp: new Date(),
  };
}

function formatMetricForCloudWatch(metric: Metric): Record<string, unknown> {
  const data: Record<string, unknown> = {
    MetricName: metric.name,
    Value: metric.value,
    Unit: metric.unit,
    Timestamp: metric.timestamp,
  };

  if (Object.keys(metric.dimensions).length > 0) {
    data.Dimensions = Object.entries(metric.dimensions).map(([Name, Value]) => ({ Name, Value }));
  }

  return data;
}

let cloudWatchClient: {
  putMetricData: (params: Record<string, unknown>) => Promise<unknown>;
} | null = null;

async function getCloudWatchClient(): Promise<typeof cloudWatchClient> {
  if (cloudWatchClient) {
    return cloudWatchClient;
  }

  try {
    // Optional dependency — only available in AWS Lambda environments
    const moduleName = '@aws-sdk/client-cloudwatch';
    const sdk = await (import(/* webpackIgnore: true */ moduleName) as Promise<{
      CloudWatchClient: new (config: Record<string, unknown>) => {
        send: (command: unknown) => Promise<unknown>;
      };
      PutMetricDataCommand: new (input: Record<string, unknown>) => unknown;
    }>);
    const client = new sdk.CloudWatchClient({});
    cloudWatchClient = {
      putMetricData: (params): Promise<unknown> =>
        client.send(new sdk.PutMetricDataCommand(params)),
    };
    return cloudWatchClient;
  } catch {
    console.warn('@aws-sdk/client-cloudwatch not available, metrics disabled');
    return null;
  }
}

export async function publishMetric(
  name: string,
  value: number,
  options?: {
    unit?: MetricUnit;
    dimensions?: Record<string, string>;
    namespace?: string;
  },
): Promise<void> {
  const metric = createMetric(name, value, options);
  const client = await getCloudWatchClient();
  if (!client) return;

  await client.putMetricData({
    Namespace: options?.namespace ?? DEFAULT_NAMESPACE,
    MetricData: [formatMetricForCloudWatch(metric)],
  });
}

export async function publishMetricsBatch(
  metrics: readonly Metric[],
  options?: { namespace?: string },
): Promise<void> {
  if (metrics.length === 0) return;

  const client = await getCloudWatchClient();
  if (!client) return;

  const namespace = options?.namespace ?? DEFAULT_NAMESPACE;
  const batchSize = 1000;

  for (let i = 0; i < metrics.length; i += batchSize) {
    const batch = metrics.slice(i, i + batchSize);
    await client.putMetricData({
      Namespace: namespace,
      MetricData: batch.map(formatMetricForCloudWatch),
    });
  }
}
