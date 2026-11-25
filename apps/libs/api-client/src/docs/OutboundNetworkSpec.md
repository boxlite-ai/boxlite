# OutboundNetworkSpec


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**mode** | [**NetworkMode**](NetworkMode.md) | Whether the guest may reach out | [default to undefined]
**allow_net** | **Array&lt;string&gt;** | Box-level outbound allowlist. Host protection applies even when it is empty. | [default to undefined]

## Example

```typescript
import { OutboundNetworkSpec } from './api';

const instance: OutboundNetworkSpec = {
    mode,
    allow_net,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
