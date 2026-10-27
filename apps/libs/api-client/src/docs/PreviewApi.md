# PreviewApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getBoxInboundMode**](#getboxinboundmode) | **GET** /preview/{boxId}/inbound | Read the inbound mode of a box|
|[**hasBoxAccess**](#hasboxaccess) | **GET** /preview/{boxId}/access | Check if user has access to the box|

# **getBoxInboundMode**
> string getBoxInboundMode()


### Example

```typescript
import {
    PreviewApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new PreviewApi(configuration);

let boxId: string; //ID of the box

const { status, data } = await apiInstance.getBoxInboundMode(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |


### Return type

**string**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Inbound mode of the box: &#x60;enabled&#x60; means the proxy may serve its services without sign-in |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **hasBoxAccess**
> boolean hasBoxAccess()


### Example

```typescript
import {
    PreviewApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new PreviewApi(configuration);

let boxId: string; //

const { status, data } = await apiInstance.hasBoxAccess(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | |


### Return type

**boolean**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | User access status to the box |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

