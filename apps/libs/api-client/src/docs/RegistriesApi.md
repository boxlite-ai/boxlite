# RegistriesApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createRegistryCredential**](#createregistrycredential) | **POST** /images/registries | Add a registry credential|
|[**deleteRegistryCredential**](#deleteregistrycredential) | **DELETE** /images/registries/{id} | Remove a registry credential|
|[**listRegistryCredentials**](#listregistrycredentials) | **GET** /images/registries | List registry credentials|
|[**updateRegistryCredential**](#updateregistrycredential) | **PUT** /images/registries/{id} | Update a registry credential|

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

# **updateRegistryCredential**
> RegistryCredential updateRegistryCredential(updateRegistryCredential)

Replace the username and password without changing its scope or destroying dependent Boxes.

### Example

```typescript
import {
    RegistriesApi,
    Configuration,
    UpdateRegistryCredential
} from './api';

const configuration = new Configuration();
const apiInstance = new RegistriesApi(configuration);

let id: string; //Credential ID
let updateRegistryCredential: UpdateRegistryCredential; //Replacement username and password
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.updateRegistryCredential(
    id,
    updateRegistryCredential,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateRegistryCredential** | **UpdateRegistryCredential**| Replacement username and password | |
| **id** | [**string**] | Credential ID | |
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
|**200** |  |  -  |
|**404** | No such credential in this organization |  -  |
|**409** | Another request is using the credential; retry the update |  -  |
|**501** | Private registries are not enabled in this deployment |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

