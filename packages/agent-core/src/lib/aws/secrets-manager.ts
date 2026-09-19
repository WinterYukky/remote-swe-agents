import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export const secretsManager = new SecretsManagerClient({});

/**
 * Get a secret string from AWS Secrets Manager.
 * @param secretId The name or ARN of the secret
 * @returns The secret string value
 * @throws when the secret does not exist, access is denied, or the secret has
 *   no string value (binary-only secrets are not supported here).
 */
export const getSecretString = async (secretId: string): Promise<string> => {
  const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (response.SecretString === undefined) {
    throw new Error(`Secret ${secretId} has no SecretString value.`);
  }
  return response.SecretString;
};
