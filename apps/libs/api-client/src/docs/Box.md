# Box


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | The public 12-character Box ID | [default to undefined]
**organizationId** | **string** | The organization ID of the box | [default to undefined]
**name** | **string** | The name of the box | [default to undefined]
**user** | **string** | The user associated with the project | [default to undefined]
**env** | **{ [key: string]: string; }** | Environment variables for the box | [default to undefined]
**labels** | **{ [key: string]: string; }** | Labels for the box | [default to undefined]
**_public** | **boolean** | Whether the box http preview is public | [default to undefined]
**networkBlockAll** | **boolean** | Whether to block all network access for the box | [default to undefined]
**networkAllowList** | **string** | Comma-separated list of allowed CIDR network addresses for the box | [optional] [default to undefined]
**target** | **string** | The target environment for the box | [default to undefined]
**image** | **string** | The image used for the box | [optional] [default to undefined]
**cpu** | **number** | The CPU quota for the box | [default to undefined]
**gpu** | **number** | The GPU quota for the box | [default to undefined]
**memory** | **number** | The memory quota for the box | [default to undefined]
**disk** | **number** | The disk quota for the box | [default to undefined]
**state** | [**BoxState**](BoxState.md) | The state of the box | [optional] [default to undefined]
**desiredState** | [**BoxDesiredState**](BoxDesiredState.md) | The desired state of the box | [optional] [default to undefined]
**errorReason** | **string** | The error reason of the box | [optional] [default to undefined]
**recoverable** | **boolean** | Whether the box error is recoverable. | [optional] [default to undefined]
**autoPause** | **number** | Auto-pause interval in seconds (0 means disabled) | [optional] [default to undefined]
**autoDelete** | **number** | Auto-delete interval in seconds (0 means disabled) | [optional] [default to undefined]
**autoResume** | **boolean** | Whether the box should be automatically resumed on proxy access | [optional] [default to undefined]
**volumes** | [**Array&lt;BoxVolume&gt;**](BoxVolume.md) | Array of volumes attached to the box | [optional] [default to undefined]
**createdAt** | **string** | The creation timestamp of the box | [optional] [default to undefined]
**updatedAt** | **string** | The last update timestamp of the box | [optional] [default to undefined]
**_class** | **string** | The class of the box | [optional] [default to undefined]
**daemonVersion** | **string** | The version of the daemon running in the box | [optional] [default to undefined]
**runnerId** | **string** | The runner ID of the box | [optional] [default to undefined]
**toolboxProxyUrl** | **string** | The toolbox proxy URL for the box | [default to undefined]

## Example

```typescript
import { Box } from './api';

const instance: Box = {
    id,
    organizationId,
    name,
    user,
    env,
    labels,
    _public,
    networkBlockAll,
    networkAllowList,
    target,
    image,
    cpu,
    gpu,
    memory,
    disk,
    state,
    desiredState,
    errorReason,
    recoverable,
    autoPause,
    autoDelete,
    autoResume,
    volumes,
    createdAt,
    updatedAt,
    _class,
    daemonVersion,
    runnerId,
    toolboxProxyUrl,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
