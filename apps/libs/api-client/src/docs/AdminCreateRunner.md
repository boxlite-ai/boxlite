# AdminCreateRunner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**regionId** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**apiKey** | **string** |  | [default to undefined]
**apiVersion** | **string** | The api version of the runner to create | [default to undefined]
**domain** | **string** | The domain of the runner | [optional] [default to undefined]
**apiUrl** | **string** | The API URL of the runner | [optional] [default to undefined]
**proxyUrl** | **string** | The proxy URL of the runner | [optional] [default to undefined]
**cpu** | **number** | The CPU capacity of the runner | [optional] [default to undefined]
**memoryGiB** | **number** | The memory capacity of the runner in GiB | [optional] [default to undefined]
**diskGiB** | **number** | The disk capacity of the runner in GiB | [optional] [default to undefined]

## Example

```typescript
import { AdminCreateRunner } from './api';

const instance: AdminCreateRunner = {
    regionId,
    name,
    apiKey,
    apiVersion,
    domain,
    apiUrl,
    proxyUrl,
    cpu,
    memoryGiB,
    diskGiB,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
