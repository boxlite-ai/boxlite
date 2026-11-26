# BoxliteTimingApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**boxliteTimingControllerGetTiming**](#boxlitetimingcontrollergettiming) | **GET** /timing/{box_id} | |

# **boxliteTimingControllerGetTiming**
> boxliteTimingControllerGetTiming()


### Example

```typescript
import {
    BoxliteTimingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxliteTimingApi(configuration);

let boxId: string; //

const { status, data } = await apiInstance.boxliteTimingControllerGetTiming(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | |


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

