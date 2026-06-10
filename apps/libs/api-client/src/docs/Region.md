# Region


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Region ID | [default to undefined]
**name** | **string** | Region name | [default to undefined]
**organizationId** | **string** | Organization ID | [optional] [default to undefined]
**regionType** | [**RegionType**](RegionType.md) | The type of the region | [default to undefined]
**createdAt** | **string** | Creation timestamp | [default to undefined]
**updatedAt** | **string** | Last update timestamp | [default to undefined]
**proxyUrl** | **string** | Proxy URL for the region | [optional] [default to undefined]
**sshGatewayUrl** | **string** | SSH Gateway URL for the region | [optional] [default to undefined]
**snapshotManagerUrl** | **string** | Snapshot Manager URL for the region | [optional] [default to undefined]

## Example

```typescript
import { Region } from './api';

const instance: Region = {
    id,
    name,
    organizationId,
    regionType,
    createdAt,
    updatedAt,
    proxyUrl,
    sshGatewayUrl,
    snapshotManagerUrl,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
