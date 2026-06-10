# CreateDockerRegistry


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** | Registry name | [default to undefined]
**url** | **string** | Registry URL | [default to undefined]
**username** | **string** | Registry username | [default to undefined]
**password** | **string** | Registry password | [default to undefined]
**project** | **string** | Registry project | [optional] [default to undefined]
**registryType** | **string** | Registry type | [default to RegistryTypeEnum_ORGANIZATION]
**isDefault** | **boolean** | Set as default registry | [optional] [default to undefined]

## Example

```typescript
import { CreateDockerRegistry } from './api';

const instance: CreateDockerRegistry = {
    name,
    url,
    username,
    password,
    project,
    registryType,
    isDefault,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
