# CreateRegionResponse


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | ID of the created region | [default to undefined]
**proxyApiKey** | **string** | Proxy API key for the region | [optional] [default to undefined]
**sshGatewayApiKey** | **string** | SSH Gateway API key for the region | [optional] [default to undefined]
**snapshotManagerUsername** | **string** | Snapshot Manager username for the region | [optional] [default to undefined]
**snapshotManagerPassword** | **string** | Snapshot Manager password for the region | [optional] [default to undefined]

## Example

```typescript
import { CreateRegionResponse } from './api';

const instance: CreateRegionResponse = {
    id,
    proxyApiKey,
    sshGatewayApiKey,
    snapshotManagerUsername,
    snapshotManagerPassword,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
