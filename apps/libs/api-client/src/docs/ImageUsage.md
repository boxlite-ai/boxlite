# ImageUsage


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**count** | **number** | Images this organization holds. Curated images are the operator’s and are not counted | [default to undefined]
**limit** | **number** | How many images this organization may hold | [default to undefined]
**knownBytes** | **number** | Sum of the declared sizes of every pulled version, in bytes. A lower bound on what is stored: it counts what the manifests said, and counts a layer once per version that references it | [default to undefined]

## Example

```typescript
import { ImageUsage } from './api';

const instance: ImageUsage = {
    count,
    limit,
    knownBytes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
