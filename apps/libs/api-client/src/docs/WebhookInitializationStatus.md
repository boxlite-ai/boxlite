# WebhookInitializationStatus


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**organizationId** | **string** | Organization ID | [default to undefined]
**svixApplicationId** | **string** | The ID of the Svix application | [default to undefined]
**lastError** | **string** | The error reason for the last initialization attempt | [default to undefined]
**retryCount** | **number** | The number of times the initialization has been attempted | [default to undefined]
**createdAt** | **string** | When the webhook initialization was created | [default to undefined]
**updatedAt** | **string** | When the webhook initialization was last updated | [default to undefined]

## Example

```typescript
import { WebhookInitializationStatus } from './api';

const instance: WebhookInitializationStatus = {
    organizationId,
    svixApplicationId,
    lastError,
    retryCount,
    createdAt,
    updatedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
