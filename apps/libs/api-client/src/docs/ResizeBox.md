# ResizeBox


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**cpu** | **number** | CPU cores to allocate to the box (minimum: 1) | [optional] [default to undefined]
**memory** | **number** | Memory in GB to allocate to the box (minimum: 1) | [optional] [default to undefined]
**disk** | **number** | Disk space in GB to allocate to the box (can only be increased) | [optional] [default to undefined]

## Example

```typescript
import { ResizeBox } from './api';

const instance: ResizeBox = {
    cpu,
    memory,
    disk,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
