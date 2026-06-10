# CreateBox


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** | The name of the box. If not provided, the box ID will be used as the name | [optional] [default to undefined]
**snapshot** | **string** | The ID or name of the snapshot used for the box | [optional] [default to undefined]
**user** | **string** | The user associated with the project | [optional] [default to undefined]
**env** | **{ [key: string]: string; }** | Environment variables for the box | [optional] [default to undefined]
**labels** | **{ [key: string]: string; }** | Labels for the box | [optional] [default to undefined]
**_public** | **boolean** | Whether the box http preview is publicly accessible | [optional] [default to undefined]
**networkBlockAll** | **boolean** | Whether to block all network access for the box | [optional] [default to undefined]
**networkAllowList** | **string** | Comma-separated list of allowed CIDR network addresses for the box | [optional] [default to undefined]
**_class** | **string** | The box class type | [optional] [default to undefined]
**target** | **string** | The target (region) where the box will be created | [optional] [default to undefined]
**cpu** | **number** | CPU cores allocated to the box | [optional] [default to undefined]
**gpu** | **number** | GPU units allocated to the box | [optional] [default to undefined]
**memory** | **number** | Memory allocated to the box in GB | [optional] [default to undefined]
**disk** | **number** | Disk space allocated to the box in GB | [optional] [default to undefined]
**autoStopInterval** | **number** | Auto-stop interval in minutes (0 means disabled) | [optional] [default to undefined]
**autoArchiveInterval** | **number** | Auto-archive interval in minutes (0 means the maximum interval will be used) | [optional] [default to undefined]
**autoDeleteInterval** | **number** | Auto-delete interval in minutes (negative value means disabled, 0 means delete immediately upon stopping) | [optional] [default to undefined]
**volumes** | [**Array&lt;BoxVolume&gt;**](BoxVolume.md) | Array of volumes to attach to the box | [optional] [default to undefined]
**buildInfo** | [**CreateBuildInfo**](CreateBuildInfo.md) | Build information for the box | [optional] [default to undefined]

## Example

```typescript
import { CreateBox } from './api';

const instance: CreateBox = {
    name,
    snapshot,
    user,
    env,
    labels,
    _public,
    networkBlockAll,
    networkAllowList,
    _class,
    target,
    cpu,
    gpu,
    memory,
    disk,
    autoStopInterval,
    autoArchiveInterval,
    autoDeleteInterval,
    volumes,
    buildInfo,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
