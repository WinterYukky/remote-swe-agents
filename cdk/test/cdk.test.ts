import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'fs';
import { MainStack } from '../lib/cdk-stack';
import { UsEast1Stack } from '../lib/us-east-1-stack';

test('Snapshot test', () => {
  jest.useFakeTimers().setSystemTime(new Date('2020-01-01'));

  const app = new cdk.App({
    context: {
      ...JSON.parse(readFileSync('cdk.json').toString()).context,
    },
  });

  // Create the UsEast1Stack first
  const usEast1Stack = new UsEast1Stack(app, 'TestUsEast1Stack', {
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
    crossRegionReferences: true,
    // Add WAF IP restriction settings for testing
    allowedIpV4AddressRanges: ['192.168.1.0/24', '10.0.0.0/8'],
    allowedIpV6AddressRanges: ['2001:db8::/32'],
    allowedCountryCodes: ['JP', 'US'],
  });

  // Create the main stack with signPayloadHandler from UsEast1Stack
  const main = new MainStack(app, `TestMainStack`, {
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
    crossRegionReferences: true,
    signPayloadHandler: usEast1Stack.signPayloadHandler,
    cloudFrontWebAclArn: usEast1Stack.webAclArn,
    slack: {
      botTokenParameterName: '/remote-swe/slack/bot-token',
      signingSecretParameterName: '/remote-swe/slack/signing-secret',
      adminUserIdList: undefined,
    },
    github: {
      privateKeyParameterName: '/remote-swe/github/app-private-key',
      appId: '123456',
      installationId: '9876543',
    },
    additionalManagedPolicies: [
      'AmazonS3ReadOnlyAccess',
      'AmazonDynamoDBReadOnlyAccess',
      'arn:aws:iam::aws:policy/AmazonECR-FullAccess',
      'arn:aws:iam::123456789012:policy/CustomPolicy',
    ],
    initialWebappUserEmail: 'user@example.com',
    bedrockCriRegionOverride: 'global',
  });

  // Test both stacks
  expect(Template.fromStack(usEast1Stack)).toMatchSnapshot('UsEast1Stack');
  expect(Template.fromStack(main)).toMatchSnapshot('MainStack');
});

test('Kiro CLI inference mode wiring (opt-in)', () => {
  jest.useFakeTimers().setSystemTime(new Date('2020-01-01'));

  const app = new cdk.App({
    context: {
      ...JSON.parse(readFileSync('cdk.json').toString()).context,
    },
  });

  const usEast1Stack = new UsEast1Stack(app, 'TestUsEast1StackKiro', {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
  });

  const main = new MainStack(app, 'TestMainStackKiro', {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
    signPayloadHandler: usEast1Stack.signPayloadHandler,
    cloudFrontWebAclArn: usEast1Stack.webAclArn,
    slack: {
      botTokenParameterName: '/remote-swe/slack/bot-token',
      signingSecretParameterName: '/remote-swe/slack/signing-secret',
      adminUserIdList: undefined,
    },
    github: {
      privateKeyParameterName: '/remote-swe/github/app-private-key',
      appId: '123456',
      installationId: '9876543',
    },
    kiroApiKeyParameterName: '/remote-swe/kiro/api-key',
    inferenceMode: 'kiro-cli',
  });

  const template = Template.fromStack(main);

  // The Kiro env vars live in the SSM "overflow" parameter (JSON) rather than
  // the runtime's inline EnvironmentVariables, because the AgentCore V2
  // env-var payload is capped at 1024 bytes; run.sh loads the parameter and
  // re-exports each key at startup.
  const overflowParams = template.findResources('AWS::SSM::Parameter', {
    Properties: { Name: Match.stringLikeRegexp('agent-core/runtime-env') },
  });
  expect(Object.keys(overflowParams)).toHaveLength(1);
  const overflowValue = JSON.stringify(Object.values(overflowParams)[0].Properties.Value);
  expect(overflowValue).toContain('KIRO_API_KEY_SSM_PARAM');
  expect(overflowValue).toContain('/remote-swe/kiro/api-key');
  expect(overflowValue).toContain('INFERENCE_MODE');
  expect(overflowValue).toContain('kiro-cli');

  // STACK_NAME stays inline (run.sh-visible before the JSON load)
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: {
      STACK_NAME: 'TestMainStackKiro',
    },
  });

  // The worker role can read the per-user Kiro API key parameters
  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const perUserGrant = statements.find(
    (s: any) =>
      s.Action === 'ssm:GetParameter' &&
      JSON.stringify(s.Resource).includes('parameter/TestMainStackKiro/users/*/kiro-api-key')
  );
  expect(perUserGrant).toBeDefined();
});

// Regression guard for the AgentCore V2 env-var payload cap (1024 bytes,
// summed over key+value). The runtime's inline EnvironmentVariables can grow
// past that cap as configuration accumulates; the mitigation moves all but a
// small, deliberately-chosen set into an SSM "overflow" parameter that run.sh
// re-exports at startup. This test freezes the inline key set so that ANY
// future addition of a variable directly to the runtime's EnvironmentVariables
// (instead of the overflow parameter) fails here loudly.
//
// Why keys, not bytes: the values are unresolved CFN tokens at synth time, so
// the resolved byte count is not knowable in a synth-only unit test. Freezing
// the exact key set is the practical breakwater — a new inline var is exactly
// the failure mode that reintroduces the payload-cap regression.
//
// NOTE on headroom: these 7 inline vars resolve to roughly 320 bytes in a
// typical deployment, leaving ~700 bytes of margin under the 1024 cap. The
// dominant variable-length contributor is STACK_NAME (it also appears verbatim
// inside three of the SSM parameter-NAME references). An extremely long stack
// name could erode that margin, so if a new stack uses a very long name,
// re-measure the resolved inline payload rather than assuming the margin holds.
test('AgentCore runtime inline EnvironmentVariables key set is frozen (V2 1024-byte payload guard)', () => {
  jest.useFakeTimers().setSystemTime(new Date('2020-01-01'));

  const app = new cdk.App({
    context: {
      ...JSON.parse(readFileSync('cdk.json').toString()).context,
    },
  });

  const usEast1Stack = new UsEast1Stack(app, 'EnvGuardUsEast1Stack', {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
    allowedIpV4AddressRanges: ['192.168.1.0/24'],
    allowedIpV6AddressRanges: ['2001:db8::/32'],
    allowedCountryCodes: ['JP'],
  });

  const main = new MainStack(app, 'EnvGuardMainStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
    signPayloadHandler: usEast1Stack.signPayloadHandler,
    cloudFrontWebAclArn: usEast1Stack.webAclArn,
    slack: {
      botTokenParameterName: '/remote-swe/slack/bot-token',
      signingSecretParameterName: '/remote-swe/slack/signing-secret',
      adminUserIdList: undefined,
    },
    github: {
      privateKeyParameterName: '/remote-swe/github/app-private-key',
      appId: '123456',
      installationId: '9876543',
    },
    initialWebappUserEmail: 'user@example.com',
    bedrockCriRegionOverride: 'global',
  });

  const template = Template.fromStack(main);
  const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
  const runtimeEntries = Object.values(runtimes);
  expect(runtimeEntries).toHaveLength(1);

  const inlineEnv = runtimeEntries[0].Properties.EnvironmentVariables as Record<string, unknown>;
  const actualKeys = Object.keys(inlineEnv).sort();

  // The ONLY variables allowed inline on the runtime. Everything else must live
  // in the SSM overflow parameter (see AgentCoreRuntime). Adding a key here
  // without measuring the resolved payload risks the 1024-byte V2 cap.
  const expectedInlineKeys = [
    'AWS_REGION',
    'GITHUB_APP_PRIVATE_KEY_PARAMETER_NAME',
    'GITHUB_PERSONAL_ACCESS_TOKEN_PARAMETER_NAME',
    'RUNTIME_ENV_PARAMETER_NAME',
    'SLACK_BOT_TOKEN_PARAMETER_NAME',
    'STACK_NAME',
    'WORKER_RUNTIME',
  ].sort();

  expect(actualKeys).toEqual(expectedInlineKeys);
});
