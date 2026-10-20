# ImageVersion


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Version ID | [default to undefined]
**digest** | **string** | OCI manifest digest this version was pulled at | [default to undefined]
**sizeBytes** | **number** | Sum of the layer sizes the manifest declared, in bytes | [default to undefined]
**sourceRef** | **string** | The reference the caller asked for, kept verbatim as provenance | [default to undefined]
**aliases** | **Array&lt;string&gt;** | Aliases that point at this version now, so a reference with one of them boots it | [default to undefined]
**lastUsedAt** | **string** | When a box last started from this version. Null when none has since this was recorded | [default to undefined]
**upstreamMissingAt** | **string** | When a pull of this version first failed because its registry no longer has it. Runners that cached it still start it; elsewhere, create a new alias for a version the registry still has. Null while no pull has found it gone | [default to undefined]
**createdAt** | **string** | When this version was first recorded | [default to undefined]

## Example

```typescript
import { ImageVersion } from './api';

const instance: ImageVersion = {
    id,
    digest,
    sizeBytes,
    sourceRef,
    aliases,
    lastUsedAt,
    upstreamMissingAt,
    createdAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
