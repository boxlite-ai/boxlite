# AuthApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**logoutControllerEndSession**](#logoutcontrollerendsession) | **GET** /auth/end-session | OIDC RP-initiated logout endpoint|

# **logoutControllerEndSession**
> logoutControllerEndSession()

Implements OpenID Connect RP-Initiated Logout 1.0 for IdPs (e.g. Dex) that do not natively advertise end_session_endpoint. Validates the post-logout redirect target, then 302-redirects the browser back to the SPA.

### Example

```typescript
import {
    AuthApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AuthApi(configuration);

let postLogoutRedirectUri: string; // (optional) (default to undefined)
let idTokenHint: string; // (optional) (default to undefined)
let state: string; // (optional) (default to undefined)

const { status, data } = await apiInstance.logoutControllerEndSession(
    postLogoutRedirectUri,
    idTokenHint,
    state
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **postLogoutRedirectUri** | [**string**] |  | (optional) defaults to undefined|
| **idTokenHint** | [**string**] |  | (optional) defaults to undefined|
| **state** | [**string**] |  | (optional) defaults to undefined|


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**302** | Redirect to post_logout_redirect_uri |  -  |
|**400** | post_logout_redirect_uri not allowed |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

