# InfoApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getUserHomeDir**](#getuserhomedir) | **GET** /user-home-dir | Get user home directory|
|[**getVersion**](#getversion) | **GET** /version | Get version|
|[**getWorkDir**](#getworkdir) | **GET** /work-dir | Get working directory|

# **getUserHomeDir**
> UserHomeDirResponse getUserHomeDir()

Get the current user home directory path.

### Example

```typescript
import {
    InfoApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InfoApi(configuration);

const { status, data } = await apiInstance.getUserHomeDir();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**UserHomeDirResponse**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getVersion**
> { [key: string]: string; } getVersion()

Get the current daemon version

### Example

```typescript
import {
    InfoApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InfoApi(configuration);

const { status, data } = await apiInstance.getVersion();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**{ [key: string]: string; }**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getWorkDir**
> WorkDirResponse getWorkDir()

Get the current working directory path. This is default directory used for running commands.

### Example

```typescript
import {
    InfoApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InfoApi(configuration);

const { status, data } = await apiInstance.getWorkDir();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**WorkDirResponse**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

