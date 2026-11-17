# AdminCiConnectionCreate


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**account_type** | **string** |  | [default to undefined]
**github_account** | **string** |  | [default to undefined]
**allow_private_repositories** | **boolean** | Explicitly allow installed private repositories; public repositories remain eligible. | [default to undefined]
**force** | **boolean** | Permit replacement only with both observed expected_binding_id and expected_generation. | [optional] [default to false]
**expected_binding_id** | **string** | Required with force:true; omit for ordinary creation. | [optional] [default to undefined]
**expected_generation** | **string** | Observed generation, required with force:true; omit for ordinary creation. | [optional] [default to undefined]

## Example

```typescript
import { AdminCiConnectionCreate } from './api';

const instance: AdminCiConnectionCreate = {
    account_type,
    github_account,
    allow_private_repositories,
    force,
    expected_binding_id,
    expected_generation,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
