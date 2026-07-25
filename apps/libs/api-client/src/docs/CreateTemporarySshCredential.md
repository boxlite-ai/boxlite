# CreateTemporarySshCredential


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**grantId** | **string** | ID of a previously issued, active &#x60;ssh&#x60;-scoped access grant for this box | [default to undefined]
**publicKey** | **string** | Canonical OpenSSH public key line, e.g. \&quot;ssh-ed25519 AAAA... user@host\&quot; | [default to undefined]
**expiresInSeconds** | **number** | Credential lifetime in seconds (default 300, max bounded by the parent grant expiry) | [optional] [default to undefined]

## Example

```typescript
import { CreateTemporarySshCredential } from './api';

const instance: CreateTemporarySshCredential = {
    grantId,
    publicKey,
    expiresInSeconds,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
