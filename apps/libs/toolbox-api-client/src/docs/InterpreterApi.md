# InterpreterApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createInterpreterContext**](#createinterpretercontext) | **POST** /process/interpreter/context | Create a new interpreter context|
|[**deleteInterpreterContext**](#deleteinterpretercontext) | **DELETE** /process/interpreter/context/{id} | Delete an interpreter context|
|[**executeInterpreterCode**](#executeinterpretercode) | **GET** /process/interpreter/execute | Execute code in an interpreter context|
|[**listInterpreterContexts**](#listinterpretercontexts) | **GET** /process/interpreter/context | List all user-created interpreter contexts|

# **createInterpreterContext**
> InterpreterContext createInterpreterContext(request)

Creates a new isolated interpreter context with optional working directory and language

### Example

```typescript
import {
    InterpreterApi,
    Configuration,
    CreateContextRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new InterpreterApi(configuration);

let request: CreateContextRequest; //Context configuration

const { status, data } = await apiInstance.createInterpreterContext(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **CreateContextRequest**| Context configuration | |


### Return type

**InterpreterContext**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**400** | Bad Request |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteInterpreterContext**
> { [key: string]: string; } deleteInterpreterContext()

Deletes an interpreter context and shuts down its worker process

### Example

```typescript
import {
    InterpreterApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InterpreterApi(configuration);

let id: string; //Context ID (default to undefined)

const { status, data } = await apiInstance.deleteInterpreterContext(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Context ID | defaults to undefined|


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
|**400** | Bad Request |  -  |
|**404** | Not Found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **executeInterpreterCode**
> executeInterpreterCode()

Executes code in a specified context (or default context if not specified) via WebSocket streaming

### Example

```typescript
import {
    InterpreterApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InterpreterApi(configuration);

const { status, data } = await apiInstance.executeInterpreterCode();
```

### Parameters
This endpoint does not have any parameters.


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**101** | Switching Protocols |  * Connection - Upgrade <br>  * Upgrade - websocket <br>  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listInterpreterContexts**
> ListContextsResponse listInterpreterContexts()

Returns information about all user-created interpreter contexts (excludes default context)

### Example

```typescript
import {
    InterpreterApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InterpreterApi(configuration);

const { status, data } = await apiInstance.listInterpreterContexts();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**ListContextsResponse**

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

