/** Include the account and app length so hyphenated app/stage pairs have distinct S3 names. */
export const stageDataBucketName = (
  app: string,
  stage: string,
  accountId: string,
  purpose: 'storage' | 'checkpoints',
) => `bl-${accountId}-${app.length}-${app}-${stage}-${purpose}`
