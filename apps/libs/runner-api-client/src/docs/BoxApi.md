# BoxApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**create**](#create) | **POST** /boxes | Create a box|
|[**createBackup**](#createbackup) | **POST** /boxes/{boxId}/backup | Create box backup|
|[**destroy**](#destroy) | **POST** /boxes/{boxId}/destroy | Destroy box|
|[**getNetworkSettings**](#getnetworksettings) | **GET** /boxes/{boxId}/network-settings | Get box network settings|
|[**info**](#info) | **GET** /boxes/{boxId} | Get box info|
|[**isRecoverable**](#isrecoverable) | **POST** /boxes/{boxId}/is-recoverable | Check if box error is recoverable|
|[**recover**](#recover) | **POST** /boxes/{boxId}/recover | Recover box from error state|
|[**resize**](#resize) | **POST** /boxes/{boxId}/resize | Resize box|
|[**start**](#start) | **POST** /boxes/{boxId}/start | Start box|
|[**stop**](#stop) | **POST** /boxes/{boxId}/stop | Stop box|
|[**updateNetworkSettings**](#updatenetworksettings) | **POST** /boxes/{boxId}/network-settings | Update box network settings|

# **create**
> StartBoxResponse create(box)

Create a box

### Example

```typescript
import {
    BoxApi,
    Configuration,
    CreateBoxDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let box: CreateBoxDTO; //Create box

const { status, data } = await apiInstance.create(
    box
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **box** | **CreateBoxDTO**| Create box | |


### Return type

**StartBoxResponse**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Created |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createBackup**
> string createBackup(box)

Create box backup

### Example

```typescript
import {
    BoxApi,
    Configuration,
    CreateBackupDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)
let box: CreateBackupDTO; //Create backup

const { status, data } = await apiInstance.createBackup(
    boxId,
    box
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **box** | **CreateBackupDTO**| Create backup | |
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Backup started |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **destroy**
> string destroy()

Destroy box

### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)

const { status, data } = await apiInstance.destroy(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Box destroyed |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getNetworkSettings**
> UpdateNetworkSettingsDTO getNetworkSettings()

Get box network settings

### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)

const { status, data } = await apiInstance.getNetworkSettings(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**UpdateNetworkSettingsDTO**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Network settings |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **info**
> BoxInfoResponse info()

Get box info

### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)

const { status, data } = await apiInstance.info(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**BoxInfoResponse**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Box info |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **isRecoverable**
> IsRecoverableResponse isRecoverable(request)

Check if the box\'s error reason indicates a recoverable error

### Example

```typescript
import {
    BoxApi,
    Configuration,
    IsRecoverableDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)
let request: IsRecoverableDTO; //Error reason to check

const { status, data } = await apiInstance.isRecoverable(
    boxId,
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **IsRecoverableDTO**| Error reason to check | |
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**IsRecoverableResponse**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**400** | Bad Request |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **recover**
> string recover(recovery)

Recover box from error state using specified recovery type

### Example

```typescript
import {
    BoxApi,
    Configuration,
    RecoverBoxDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)
let recovery: RecoverBoxDTO; //Recovery parameters

const { status, data } = await apiInstance.recover(
    boxId,
    recovery
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **recovery** | **RecoverBoxDTO**| Recovery parameters | |
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Box recovered |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **resize**
> string resize(box)

Resize box

### Example

```typescript
import {
    BoxApi,
    Configuration,
    ResizeBoxDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)
let box: ResizeBoxDTO; //Resize box

const { status, data } = await apiInstance.resize(
    boxId,
    box
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **box** | **ResizeBoxDTO**| Resize box | |
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Box resized |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **start**
> StartBoxResponse start()

Start box

### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)
let token: string; //Auth token (optional) (default to undefined)
let metadata: object; //Metadata (optional)

const { status, data } = await apiInstance.start(
    boxId,
    token,
    metadata
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **metadata** | **object**| Metadata | |
| **boxId** | [**string**] | Box ID | defaults to undefined|
| **token** | [**string**] | Auth token | (optional) defaults to undefined|


### Return type

**StartBoxResponse**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Box started |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **stop**
> string stop()

Stop box

### Example

```typescript
import {
    BoxApi,
    Configuration,
    StopBoxDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)
let box: StopBoxDTO; //Stop box (optional)

const { status, data } = await apiInstance.stop(
    boxId,
    box
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **box** | **StopBoxDTO**| Stop box | |
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Box stopped |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateNetworkSettings**
> string updateNetworkSettings(box)

Update box network settings

### Example

```typescript
import {
    BoxApi,
    Configuration,
    UpdateNetworkSettingsDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //Box ID (default to undefined)
let box: UpdateNetworkSettingsDTO; //Update network settings

const { status, data } = await apiInstance.updateNetworkSettings(
    boxId,
    box
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **box** | **UpdateNetworkSettingsDTO**| Update network settings | |
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Network settings updated |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

