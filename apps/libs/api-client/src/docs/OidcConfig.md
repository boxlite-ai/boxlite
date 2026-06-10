# OidcConfig


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**issuer** | **string** | OIDC issuer | [default to undefined]
**clientId** | **string** | OIDC client ID | [default to undefined]
**audience** | **string** | OIDC audience | [default to undefined]
**endSessionEndpoint** | **string** | OIDC end-session endpoint. Set when the IdP does not advertise one via discovery (e.g. Dex) and BoxLite hosts a compatible logout endpoint. | [optional] [default to undefined]

## Example

```typescript
import { OidcConfig } from './api';

const instance: OidcConfig = {
    issuer,
    clientId,
    audience,
    endSessionEndpoint,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
