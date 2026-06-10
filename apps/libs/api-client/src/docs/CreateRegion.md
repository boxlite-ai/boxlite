# CreateRegion


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** | Region name | [default to undefined]
**proxyUrl** | **string** | Proxy URL for the region | [optional] [default to undefined]
**sshGatewayUrl** | **string** | SSH Gateway URL for the region | [optional] [default to undefined]
**snapshotManagerUrl** | **string** | Snapshot Manager URL for the region | [optional] [default to undefined]

## Example

```typescript
import { CreateRegion } from './api';

const instance: CreateRegion = {
    name,
    proxyUrl,
    sshGatewayUrl,
    snapshotManagerUrl,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
