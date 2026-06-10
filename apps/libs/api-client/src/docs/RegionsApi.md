# RegionsApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**listSharedRegions**](#listsharedregions) | **GET** /shared-regions | List all shared regions|

# **listSharedRegions**
> Array<Region> listSharedRegions()


### Example

```typescript
import {
    RegionsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RegionsApi(configuration);

const { status, data } = await apiInstance.listSharedRegions();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Array<Region>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of all shared regions |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

