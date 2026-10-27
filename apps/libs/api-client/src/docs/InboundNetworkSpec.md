# InboundNetworkSpec


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**mode** | [**NetworkMode**](NetworkMode.md) | Whether exposed services are reachable through the proxy without sign-in | [default to undefined]
**allow_net** | **Array&lt;string&gt;** | Reserved; no layer enforces an inbound allowlist yet | [default to undefined]

## Example

```typescript
import { InboundNetworkSpec } from './api';

const instance: InboundNetworkSpec = {
    mode,
    allow_net,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
