# AdminBoxOwner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**userId** | **string** | Creator/user ID behind this owner group when available | [optional] [default to undefined]
**name** | **string** | Display name for the owner group | [default to undefined]
**email** | **string** | Owner email for personal organizations, blank when unavailable | [default to undefined]
**orgName** | **string** | Organization name backing this box | [default to undefined]
**personal** | **boolean** | Whether this is a personal organization | [default to undefined]

## Example

```typescript
import { AdminBoxOwner } from './api';

const instance: AdminBoxOwner = {
    userId,
    name,
    email,
    orgName,
    personal,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
