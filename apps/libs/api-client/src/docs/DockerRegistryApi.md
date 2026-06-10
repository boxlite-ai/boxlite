# DockerRegistryApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createRegistry**](#createregistry) | **POST** /docker-registry | Create registry|
|[**deleteRegistry**](#deleteregistry) | **DELETE** /docker-registry/{id} | Delete registry|
|[**getRegistry**](#getregistry) | **GET** /docker-registry/{id} | Get registry|
|[**getTransientPushAccess**](#gettransientpushaccess) | **GET** /docker-registry/registry-push-access | Get temporary registry access for pushing snapshots|
|[**listRegistries**](#listregistries) | **GET** /docker-registry | List registries|
|[**setDefaultRegistry**](#setdefaultregistry) | **POST** /docker-registry/{id}/set-default | Set default registry|
|[**updateRegistry**](#updateregistry) | **PATCH** /docker-registry/{id} | Update registry|

# **createRegistry**
> DockerRegistry createRegistry(createDockerRegistry)


### Example

```typescript
import {
    DockerRegistryApi,
    Configuration,
    CreateDockerRegistry
} from './api';

const configuration = new Configuration();
const apiInstance = new DockerRegistryApi(configuration);

let createDockerRegistry: CreateDockerRegistry; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createRegistry(
    createDockerRegistry,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createDockerRegistry** | **CreateDockerRegistry**|  | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**DockerRegistry**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | The docker registry has been successfully created. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteRegistry**
> deleteRegistry()


### Example

```typescript
import {
    DockerRegistryApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new DockerRegistryApi(configuration);

let id: string; //ID of the docker registry (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deleteRegistry(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | ID of the docker registry | defaults to undefined|
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
|**204** | The docker registry has been successfully deleted. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getRegistry**
> DockerRegistry getRegistry()


### Example

```typescript
import {
    DockerRegistryApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new DockerRegistryApi(configuration);

let id: string; //ID of the docker registry (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getRegistry(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | ID of the docker registry | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**DockerRegistry**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The docker registry |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getTransientPushAccess**
> RegistryPushAccessDto getTransientPushAccess()


### Example

```typescript
import {
    DockerRegistryApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new DockerRegistryApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let regionId: string; //ID of the region where the snapshot will be available (defaults to organization default region) (optional) (default to undefined)

const { status, data } = await apiInstance.getTransientPushAccess(
    xBoxLiteOrganizationID,
    regionId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **regionId** | [**string**] | ID of the region where the snapshot will be available (defaults to organization default region) | (optional) defaults to undefined|


### Return type

**RegistryPushAccessDto**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Temporary registry access has been generated |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listRegistries**
> Array<DockerRegistry> listRegistries()


### Example

```typescript
import {
    DockerRegistryApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new DockerRegistryApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.listRegistries(
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<DockerRegistry>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of all docker registries |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **setDefaultRegistry**
> DockerRegistry setDefaultRegistry()


### Example

```typescript
import {
    DockerRegistryApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new DockerRegistryApi(configuration);

let id: string; //ID of the docker registry (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.setDefaultRegistry(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | ID of the docker registry | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**DockerRegistry**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The docker registry has been set as default. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateRegistry**
> DockerRegistry updateRegistry(updateDockerRegistry)


### Example

```typescript
import {
    DockerRegistryApi,
    Configuration,
    UpdateDockerRegistry
} from './api';

const configuration = new Configuration();
const apiInstance = new DockerRegistryApi(configuration);

let id: string; //ID of the docker registry (default to undefined)
let updateDockerRegistry: UpdateDockerRegistry; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.updateRegistry(
    id,
    updateDockerRegistry,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateDockerRegistry** | **UpdateDockerRegistry**|  | |
| **id** | [**string**] | ID of the docker registry | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**DockerRegistry**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The docker registry has been successfully updated. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

