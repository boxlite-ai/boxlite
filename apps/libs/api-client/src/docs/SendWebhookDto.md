# SendWebhookDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**eventType** | [**WebhookEvent**](WebhookEvent.md) | The type of event being sent | [default to undefined]
**payload** | **object** | The payload data to send | [default to undefined]
**eventId** | **string** | Optional event ID for idempotency | [optional] [default to undefined]

## Example

```typescript
import { SendWebhookDto } from './api';

const instance: SendWebhookDto = {
    eventType,
    payload,
    eventId,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
