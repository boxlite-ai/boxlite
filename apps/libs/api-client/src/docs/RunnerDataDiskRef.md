# RunnerDataDiskRef

Cloud identity of a Runner data disk. GCP uses a project ID, zone and disk name; AWS uses an account ID, availability zone and EBS volume ID. GCP disks without diskType retain the hyperdisk_balanced compatibility default; AWS expansion requires gp3.

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**provider** | **string** | Cloud provider of the data disk | [default to undefined]
**project** | **string** | GCP project ID or AWS account ID containing the data disk | [default to undefined]
**zone** | **string** | Cloud zone the data disk lives in | [default to undefined]
**diskName** | **string** | Name of the data disk, as the cloud API addresses it | [default to undefined]
**diskType** | **string** | Disk backend, including hyperdisk_balanced, filestore or gp3. GCP disks without this field retain the hyperdisk_balanced compatibility default; AWS expansion requires gp3. | [optional] [default to undefined]

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
