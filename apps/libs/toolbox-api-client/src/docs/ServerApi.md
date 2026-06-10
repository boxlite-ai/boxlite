# ServerApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**initialize**](#initialize) | **POST** /init | Initialize toolbox server|

# **initialize**
> { [key: string]: string; } initialize(request)

Set the auth token and initialize telemetry for the toolbox server

### Example

```typescript
import {
    ServerApi,
    Configuration,
    InitializeRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ServerApi(configuration);

let request: InitializeRequest; //Initialization request

const { status, data } = await apiInstance.initialize(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **InitializeRequest**| Initialization request | |


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

