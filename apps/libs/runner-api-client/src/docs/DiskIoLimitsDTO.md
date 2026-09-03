# DiskIoLimitsDTO

DiskIoLimitsDTO caps a box\'s disk I/O: bandwidth in bytes per second and operations per second, each per direction. A zero or omitted field is unlimited. Mirrors BoxOptions.disk_io in the runtime.

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**readBps** | **number** |  | [optional] [default to undefined]
**readIops** | **number** |  | [optional] [default to undefined]
**writeBps** | **number** |  | [optional] [default to undefined]
**writeIops** | **number** |  | [optional] [default to undefined]

## Example

```typescript
import { DiskIoLimitsDTO } from './api';

const instance: DiskIoLimitsDTO = {
    readBps,
    readIops,
    writeBps,
    writeIops,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
