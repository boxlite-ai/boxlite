# RegistriesApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createRegistryCredential**](#createregistrycredential) | **POST** /registries | Add a registry credential|
|[**deleteRegistryCredential**](#deleteregistrycredential) | **DELETE** /registries/{id} | Remove a registry credential|
|[**listRegistryCredentials**](#listregistrycredentials) | **GET** /registries | List registry credentials|

# **createRegistryCredential**
> RegistryCredential createRegistryCredential(createRegistryCredential)

A login for a private registry. The password is stored where this API cannot read it back, and is never returned.

### Example

```typescript
import {
    RegistriesApi,
    Configuration,
    CreateRegistryCredential
} from './api';

const configuration = new Configuration();
const apiInstance = new RegistriesApi(configuration);

let createRegistryCredential: CreateRegistryCredential; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createRegistryCredential(
    createRegistryCredential,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createRegistryCredential** | **CreateRegistryCredential**|  | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**RegistryCredential**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** |  |  -  |
|**409** | A credential for this registry and prefix already exists |  -  |
|**501** | Private registries are not enabled in this deployment |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteRegistryCredential**
> deleteRegistryCredential()


### Example

```typescript
import {
    RegistriesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RegistriesApi(configuration);

let id: string; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deleteRegistryCredential(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] |  | |
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
|**204** | The credential is gone, and its password is destroyed |  -  |
|**404** | No such credential in this organization |  -  |
|**409** | Boxes that have not been destroyed still pull through it; their ids are listed |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listRegistryCredentials**
> Array<RegistryCredential> listRegistryCredentials()


### Example

```typescript
import {
    RegistriesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RegistriesApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.listRegistryCredentials(
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<RegistryCredential>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

