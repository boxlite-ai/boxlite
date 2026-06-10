# StorageAccessDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**accessKey** | **string** | Access key for storage authentication | [default to undefined]
**secret** | **string** | Secret key for storage authentication | [default to undefined]
**sessionToken** | **string** | Session token for storage authentication | [default to undefined]
**storageUrl** | **string** | Storage URL | [default to undefined]
**organizationId** | **string** | Organization ID | [default to undefined]
**bucket** | **string** | S3 bucket name | [default to undefined]

## Example

```typescript
import { StorageAccessDto } from './api';

const instance: StorageAccessDto = {
    accessKey,
    secret,
    sessionToken,
    storageUrl,
    organizationId,
    bucket,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
