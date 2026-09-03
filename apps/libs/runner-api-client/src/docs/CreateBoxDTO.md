# CreateBoxDTO


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**authToken** | **string** |  | [optional] [default to undefined]
**cmd** | **Array&lt;string&gt;** |  | [optional] [default to undefined]
**cpuQuota** | **number** |  | [optional] [default to undefined]
**diskIo** | [**DiskIoLimitsDTO**](DiskIoLimitsDTO.md) |  | [optional] [default to undefined]
**entrypoint** | **Array&lt;string&gt;** |  | [optional] [default to undefined]
**env** | **{ [key: string]: string; }** |  | [optional] [default to undefined]
**fromVolumeId** | **string** |  | [optional] [default to undefined]
**gpuQuota** | **number** |  | [optional] [default to undefined]
**id** | **string** |  | [default to undefined]
**image** | **string** |  | [default to undefined]
**memoryQuota** | **number** |  | [optional] [default to undefined]
**metadata** | **{ [key: string]: string; }** |  | [optional] [default to undefined]
**networkAllowList** | **string** |  | [optional] [default to undefined]
**networkBlockAll** | **boolean** |  | [optional] [default to undefined]
**organizationId** | **string** | Nullable for backward compatibility | [optional] [default to undefined]
**osUser** | **string** |  | [default to undefined]
**otelEndpoint** | **string** |  | [optional] [default to undefined]
**regionId** | **string** |  | [optional] [default to undefined]
**registry** | [**RegistryDTO**](RegistryDTO.md) |  | [optional] [default to undefined]
**runAsUser** | **string** |  | [optional] [default to undefined]
**skipStart** | **boolean** |  | [optional] [default to undefined]
**storageQuota** | **number** |  | [optional] [default to undefined]
**volumes** | [**Array&lt;DtoVolumeDTO&gt;**](DtoVolumeDTO.md) |  | [optional] [default to undefined]
**workingDir** | **string** |  | [optional] [default to undefined]

## Example

```typescript
import { CreateBoxDTO } from './api';

const instance: CreateBoxDTO = {
    authToken,
    cmd,
    cpuQuota,
    diskIo,
    entrypoint,
    env,
    fromVolumeId,
    gpuQuota,
    id,
    image,
    memoryQuota,
    metadata,
    networkAllowList,
    networkBlockAll,
    organizationId,
    osUser,
    otelEndpoint,
    regionId,
    registry,
    runAsUser,
    skipStart,
    storageQuota,
    volumes,
    workingDir,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
