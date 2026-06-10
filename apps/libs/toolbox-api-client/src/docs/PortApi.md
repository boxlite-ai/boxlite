# PortApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getPorts**](#getports) | **GET** /port | Get active ports|
|[**isPortInUse**](#isportinuse) | **GET** /port/{port}/in-use | Check if port is in use|

# **getPorts**
> PortList getPorts()

Get a list of all currently active ports

### Example

```typescript
import {
    PortApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new PortApi(configuration);

const { status, data } = await apiInstance.getPorts();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**PortList**

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

# **isPortInUse**
> IsPortInUseResponse isPortInUse()

Check if a specific port is currently in use

### Example

```typescript
import {
    PortApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new PortApi(configuration);

let port: number; //Port number (3000-9999) (default to undefined)

const { status, data } = await apiInstance.isPortInUse(
    port
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **port** | [**number**] | Port number (3000-9999) | defaults to undefined|


### Return type

**IsPortInUseResponse**

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

