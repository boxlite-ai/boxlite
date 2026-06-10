# CreateWorkspace


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**image** | **string** | The image used for the workspace | [optional] [default to undefined]
**user** | **string** | The user associated with the project | [optional] [default to undefined]
**env** | **{ [key: string]: string; }** | Environment variables for the workspace | [optional] [default to undefined]
**labels** | **{ [key: string]: string; }** | Labels for the workspace | [optional] [default to undefined]
**_public** | **boolean** | Whether the workspace http preview is publicly accessible | [optional] [default to undefined]
**_class** | **string** | The workspace class type | [optional] [default to undefined]
**target** | **string** | The target (region) where the workspace will be created | [optional] [default to undefined]
**cpu** | **number** | CPU cores allocated to the workspace | [optional] [default to undefined]
**gpu** | **number** | GPU units allocated to the workspace | [optional] [default to undefined]
**memory** | **number** | Memory allocated to the workspace in GB | [optional] [default to undefined]
**disk** | **number** | Disk space allocated to the workspace in GB | [optional] [default to undefined]
**autoStopInterval** | **number** | Auto-stop interval in minutes (0 means disabled) | [optional] [default to undefined]
**autoArchiveInterval** | **number** | Auto-archive interval in minutes (0 means the maximum interval will be used) | [optional] [default to undefined]
**volumes** | [**Array&lt;BoxVolume&gt;**](BoxVolume.md) | Array of volumes to attach to the workspace | [optional] [default to undefined]
**buildInfo** | [**CreateBuildInfo**](CreateBuildInfo.md) | Build information for the workspace | [optional] [default to undefined]

## Example

```typescript
import { CreateWorkspace } from './api';

const instance: CreateWorkspace = {
    image,
    user,
    env,
    labels,
    _public,
    _class,
    target,
    cpu,
    gpu,
    memory,
    disk,
    autoStopInterval,
    autoArchiveInterval,
    volumes,
    buildInfo,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
