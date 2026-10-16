# ImageVersion


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Version ID | [default to undefined]
**digest** | **string** | OCI manifest digest this version was pulled at | [default to undefined]
**sizeBytes** | **number** | Sum of the layer sizes the manifest declared, in bytes | [default to undefined]
**sourceRef** | **string** | The reference the caller asked for, kept verbatim as provenance | [default to undefined]
**createdAt** | **string** | When this version was first recorded | [default to undefined]

## Example

```typescript
import { ImageVersion } from './api';

const instance: ImageVersion = {
    id,
    digest,
    sizeBytes,
    sourceRef,
    createdAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
