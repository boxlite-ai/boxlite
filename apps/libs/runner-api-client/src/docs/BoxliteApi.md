# BoxliteApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**v1BoxesBoxIdExecutionsExecIdAttachGet**](#v1boxesboxidexecutionsexecidattachget) | **GET** /v1/boxes/{boxId}/executions/{execId}/attach | Attach to an execution via WebSocket|

# **v1BoxesBoxIdExecutionsExecIdAttachGet**
> v1BoxesBoxIdExecutionsExecIdAttachGet()


### Example

```typescript
import {
    BoxliteApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxliteApi(configuration);

let boxId: string; //Box ID (default to undefined)
let execId: string; //Execution ID (default to undefined)

const { status, data } = await apiInstance.v1BoxesBoxIdExecutionsExecIdAttachGet(
    boxId,
    execId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | Box ID | defaults to undefined|
| **execId** | [**string**] | Execution ID | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: */*


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**101** | Switching Protocols |  -  |
|**404** | execution not found |  -  |
|**409** | already attached |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

