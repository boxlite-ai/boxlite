# AttachTicket


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**ticket** | **string** | Single-use credential for the attach WebSocket, sent as its &#x60;ticket&#x60; query parameter | [default to undefined]
**expiresIn** | **number** | Seconds until the ticket expires | [default to undefined]

## Example

```typescript
import { AttachTicket } from './api';

const instance: AttachTicket = {
    ticket,
    expiresIn,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
