# SshAccessDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Unique identifier for the SSH access | [default to undefined]
**boxId** | **string** | ID of the box this SSH access is for | [default to undefined]
**token** | **string** | SSH access token | [default to undefined]
**expiresAt** | **Date** | When the SSH access expires | [default to undefined]
**createdAt** | **Date** | When the SSH access was created | [default to undefined]
**updatedAt** | **Date** | When the SSH access was last updated | [default to undefined]
**sshCommand** | **string** | SSH command to connect to the box | [default to undefined]

## Example

```typescript
import { SshAccessDto } from './api';

const instance: SshAccessDto = {
    id,
    boxId,
    token,
    expiresAt,
    createdAt,
    updatedAt,
    sshCommand,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
