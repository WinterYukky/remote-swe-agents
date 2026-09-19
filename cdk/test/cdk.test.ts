import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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

  // The AgentCore runtime receives the Kiro env vars
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: {
      KIRO_API_KEY_SSM_PARAM: '/remote-swe/kiro/api-key',
      INFERENCE_MODE: 'kiro-cli',
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

// Guards the AWS::ImageBuilder::Component `Data` hard limit (16000 chars).
// The snapshot test does NOT catch this: `Data` is an `Fn::Join` of literal
// chunks + unresolved CFN intrinsics (SFN/role ARNs, table/bucket names, log
// group, region), and it is the length AFTER those intrinsics resolve at
// deploy time that must be <= 16000. A snapshot that passes at synth says
// nothing about the resolved length, so a template can synthesize green and
// still fail deploy-time validation with
// "Model validation failed (#/Data: expected maxLength: 16000)".
//
// This test reconstructs the resolved-length upper bound the same way the
// service does: literal chars (exact) + a conservative per-intrinsic budget
// for the values CDK will substitute, and asserts the total stays under the
// limit with margin.
test('ImageBuilder component Data stays under the 16000-char limit after intrinsic expansion', () => {
  jest.useFakeTimers().setSystemTime(new Date('2020-01-01'));

  const app = new cdk.App({
    context: {
      ...JSON.parse(readFileSync('cdk.json').toString()).context,
    },
  });

  const usEast1Stack = new UsEast1Stack(app, 'SizeUsEast1Stack', {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
    allowedIpV4AddressRanges: ['192.168.1.0/24'],
    allowedIpV6AddressRanges: ['2001:db8::/32'],
    allowedCountryCodes: ['JP'],
  });

  const main = new MainStack(app, 'SizeMainStack', {
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
  });

  const IMAGEBUILDER_COMPONENT_DATA_MAX = 16000;
  // Conservative upper bound for a single resolved intrinsic. The longest
  // values substituted into this component are SFN state-machine / IAM role
  // ARNs (`arn:aws:states:<region>:<account>:stateMachine:<name>`, roughly
  // 120-130 chars); most of the rest are short resource names (40-60 chars).
  // Budget 96 per intrinsic sits well above the realistic average, so the
  // test trips comfortably BEFORE a real deployment would hit the limit
  // while not being so pessimistic that a healthy template fails.
  const PER_INTRINSIC_BUDGET = 96;

  const template = Template.fromStack(main);
  const components = template.findResources('AWS::ImageBuilder::Component');
  const entries = Object.entries(components);
  expect(entries.length).toBeGreaterThan(0);

  for (const [logicalId, resource] of entries) {
    const data = resource.Properties.Data;
    let literalChars = 0;
    let intrinsicCount = 0;

    if (typeof data === 'string') {
      literalChars = data.length;
    } else if (data && data['Fn::Join']) {
      const parts = data['Fn::Join'][1] as unknown[];
      for (const part of parts) {
        if (typeof part === 'string') literalChars += part.length;
        else intrinsicCount += 1;
      }
    } else {
      throw new Error(`Unexpected Data shape for ${logicalId}: ${JSON.stringify(data).slice(0, 200)}`);
    }

    const estimatedResolved = literalChars + intrinsicCount * PER_INTRINSIC_BUDGET;
    // If this fails, the diagnostic pinpoints the two levers (literal vs intrinsics):
    // shrink the ImageBuilder component template (validate/test phases) or reduce
    // the number of intrinsics baked into the AMI-time systemd unit.
    if (estimatedResolved >= IMAGEBUILDER_COMPONENT_DATA_MAX) {
      throw new Error(
        `ImageBuilder component ${logicalId} Data too large: literal=${literalChars} + ` +
          `intrinsics=${intrinsicCount}*${PER_INTRINSIC_BUDGET} => estimatedResolved=${estimatedResolved} ` +
          `(limit ${IMAGEBUILDER_COMPONENT_DATA_MAX})`
      );
    }
    expect(estimatedResolved).toBeLessThan(IMAGEBUILDER_COMPONENT_DATA_MAX);
  }
});
