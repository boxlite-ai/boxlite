# SshAccessApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createTemporarySshCredential**](#createtemporarysshcredential) | **POST** /box/{boxIdOrName}/ssh-access | Create a temporary SSH credential for a box|
|[**listTemporarySshCredentials**](#listtemporarysshcredentials) | **GET** /box/{boxIdOrName}/ssh-access | List temporary SSH credentials for a box|
|[**revokeTemporarySshCredential**](#revoketemporarysshcredential) | **DELETE** /box/{boxIdOrName}/ssh-access/{credentialId} | Revoke a temporary SSH credential|

# **createTemporarySshCredential**
> TemporarySshCredentialCreated createTemporarySshCredential(createTemporarySshCredential)


### Example

```typescript
import {
    SshAccessApi,
    Configuration,
    CreateTemporarySshCredential
} from './api';

const configuration = new Configuration();
const apiInstance = new SshAccessApi(configuration);

let boxIdOrName: string; //ID or name of the box (default to undefined)
let createTemporarySshCredential: CreateTemporarySshCredential; //
let xBoxLiteAppKey: string; //Box-scoped app key issued by a prior access-grant create call. Alternative to account authorization for creating an SSH credential; providing both is rejected. (optional) (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createTemporarySshCredential(
    boxIdOrName,
    createTemporarySshCredential,
    xBoxLiteAppKey,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createTemporarySshCredential** | **CreateTemporarySshCredential**|  | |
| **boxIdOrName** | [**string**] | ID or name of the box | defaults to undefined|
| **xBoxLiteAppKey** | [**string**] | Box-scoped app key issued by a prior access-grant create call. Alternative to account authorization for creating an SSH credential; providing both is rejected. | (optional) defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**TemporarySshCredentialCreated**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | SSH credential created and applied to the running guest. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listTemporarySshCredentials**
> Array<TemporarySshCredential> listTemporarySshCredentials()


### Example

```typescript
import {
    SshAccessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SshAccessApi(configuration);

let boxIdOrName: string; //ID or name of the box (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.listTemporarySshCredentials(
    boxIdOrName,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<TemporarySshCredential>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | SSH credentials for the box. Never includes the key body. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **revokeTemporarySshCredential**
> revokeTemporarySshCredential()


### Example

```typescript
import {
    SshAccessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SshAccessApi(configuration);

let boxIdOrName: string; //ID or name of the box (default to undefined)
let credentialId: string; //ID of the SSH credential to revoke (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.revokeTemporarySshCredential(
    boxIdOrName,
    credentialId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | defaults to undefined|
| **credentialId** | [**string**] | ID of the SSH credential to revoke | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | SSH credential has been revoked |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

