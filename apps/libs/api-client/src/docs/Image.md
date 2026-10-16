# Image


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** | What to pass as a box image to boot from this: the curated short name, or the upstream repository path | [default to undefined]
**id** | **string** | Catalog row ID. Null for curated images, which are operator configuration rather than rows | [default to undefined]
**curated** | **boolean** | Whether this is one of the operator-provided images every organization shares. Curated images cannot be deleted and do not count against the organization limit | [default to undefined]
**curatedRef** | **string** | The exact reference a curated image resolves to. Null for catalog images, which resolve through their versions | [default to undefined]
**tags** | **Array&lt;string&gt;** | Tags recorded for this image. Empty for curated images, whose reference the operator pins | [default to undefined]
**versionCount** | **number** | How many pulled manifest digests this image holds | [default to undefined]
**sizeBytes** | **number** | Sum of the pulled versions’ declared sizes, in bytes. Layers shared between versions are counted once per version. Null for curated images, whose bytes this system never measured | [default to undefined]
**lastUsedAt** | **string** | When a box last booted from this image | [default to undefined]
**createdAt** | **string** | When this image first entered the catalog. Null for curated images | [default to undefined]

## Example

```typescript
import { Image } from './api';

const instance: Image = {
    name,
    id,
    curated,
    curatedRef,
    tags,
    versionCount,
    sizeBytes,
    lastUsedAt,
    createdAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
