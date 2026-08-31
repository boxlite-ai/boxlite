# PreviewApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getBoxIdFromSignedPreviewUrlToken**](#getboxidfromsignedpreviewurltoken) | **GET** /preview/{signedPreviewToken}/{port}/box-id | Get box ID from signed preview URL token|
|[**hasBoxAccess**](#hasboxaccess) | **GET** /preview/{boxId}/access | Check if user has access to the box|
|[**isBoxPublic**](#isboxpublic) | **GET** /preview/{boxId}/public | Check if box is public|
|[**isValidAuthToken**](#isvalidauthtoken) | **GET** /preview/{boxId}/validate/{authToken} | Check if box auth token is valid|

# **getBoxIdFromSignedPreviewUrlToken**
> string getBoxIdFromSignedPreviewUrlToken()


### Example

```typescript
import {
    PreviewApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new PreviewApi(configuration);

let signedPreviewToken: string; //Signed preview URL token
let port: number; //Port number to get box ID from signed preview URL token

const { status, data } = await apiInstance.getBoxIdFromSignedPreviewUrlToken(
    signedPreviewToken,
    port
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **signedPreviewToken** | [**string**] | Signed preview URL token | |
| **port** | [**number**] | Port number to get box ID from signed preview URL token | |


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
|**200** | Box ID from signed preview URL token |  -  |

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

# **isBoxPublic**
> boolean isBoxPublic()


### Example

```typescript
import {
    PreviewApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new PreviewApi(configuration);

let boxId: string; //ID of the box

const { status, data } = await apiInstance.isBoxPublic(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |


### Return type

**boolean**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Public status of the box |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **isValidAuthToken**
> boolean isValidAuthToken()


### Example

```typescript
import {
    PreviewApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new PreviewApi(configuration);

let boxId: string; //ID of the box
let authToken: string; //Auth token of the box

const { status, data } = await apiInstance.isValidAuthToken(
    boxId,
    authToken
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |
| **authToken** | [**string**] | Auth token of the box | |


### Return type

**boolean**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Box auth token validation status |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

