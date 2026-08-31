# UsageApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getOrganizationUsageConcurrency**](#getorganizationusageconcurrency) | **GET** /organizations/{organizationId}/concurrency | Get organization concurrency timeline|

# **getOrganizationUsageConcurrency**
> UsageConcurrencySeriesDto getOrganizationUsageConcurrency()


### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let organizationId: string; //Organization ID
let from: Date; //Inclusive start of the requested timeline. Defaults to 30 days before `to`. (optional) (default to undefined)
let to: Date; //Inclusive end of the requested timeline. Defaults to the current time. (optional) (default to undefined)
let granularity: 'hour' | 'day'; //Spacing between concurrency snapshots. (optional) (default to 'day')

const { status, data } = await apiInstance.getOrganizationUsageConcurrency(
    organizationId,
    from,
    to,
    granularity
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | |
| **from** | [**Date**] | Inclusive start of the requested timeline. Defaults to 30 days before &#x60;to&#x60;. | (optional) defaults to undefined|
| **to** | [**Date**] | Inclusive end of the requested timeline. Defaults to the current time. | (optional) defaults to undefined|
| **granularity** | [**&#39;hour&#39; &#124; &#39;day&#39;**] | Spacing between concurrency snapshots. | (optional) defaults to 'day'|


### Return type

**UsageConcurrencySeriesDto**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Compute-bearing box usage periods sampled as a bounded concurrency series. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

