# RunnerDataDiskRef

Cloud identity of the runner data disk. diskType names the backend so the API can tell expandable block disks from backends with a different resize path (e.g. Filestore); runners predating the field are treated as hyperdisk_balanced, the only type infra provisions today.

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**provider** | **string** | Cloud provider of the data disk | [default to undefined]
**project** | **string** | Cloud project the data disk lives in | [default to undefined]
**zone** | **string** | Cloud zone the data disk lives in | [default to undefined]
**diskName** | **string** | Name of the data disk, as the cloud API addresses it | [default to undefined]
**diskType** | **string** | Backend behind the identity (hyperdisk_balanced, filestore, ...). Omitted by runner binaries predating the field; the API then assumes hyperdisk_balanced, the only data disk infra provisions today. | [optional] [default to undefined]

## Example

```typescript
import { RunnerDataDiskRef } from './api';

const instance: RunnerDataDiskRef = {
    provider,
    project,
    zone,
    diskName,
    diskType,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
