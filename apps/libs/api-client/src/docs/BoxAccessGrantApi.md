# BoxAccessGrantApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createBoxAccessGrant**](#createboxaccessgrant) | **POST** /box/{boxIdOrName}/access-grants | Create a box-scoped access grant|
|[**listBoxAccessGrants**](#listboxaccessgrants) | **GET** /box/{boxIdOrName}/access-grants | List box-scoped access grants|
|[**revokeBoxAccessGrant**](#revokeboxaccessgrant) | **DELETE** /box/{boxIdOrName}/access-grants/{grantId} | Revoke a box-scoped access grant|

# **createBoxAccessGrant**
> BoxAccessGrantCreated createBoxAccessGrant(createBoxAccessGrant)


### Example

```typescript
import {
    BoxAccessGrantApi,
    Configuration,
    CreateBoxAccessGrant
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxAccessGrantApi(configuration);

let boxIdOrName: string; //ID or name of the box (default to undefined)
let createBoxAccessGrant: CreateBoxAccessGrant; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createBoxAccessGrant(
    boxIdOrName,
    createBoxAccessGrant,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createBoxAccessGrant** | **CreateBoxAccessGrant**|  | |
| **boxIdOrName** | [**string**] | ID or name of the box | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**BoxAccessGrantCreated**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Access grant created. The plaintext app key is returned once and cannot be recovered later. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listBoxAccessGrants**
> Array<BoxAccessGrant> listBoxAccessGrants()


### Example

```typescript
import {
    BoxAccessGrantApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxAccessGrantApi(configuration);

let boxIdOrName: string; //ID or name of the box (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.listBoxAccessGrants(
    boxIdOrName,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<BoxAccessGrant>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Access grants for the box. Never includes the app key or its digest. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **revokeBoxAccessGrant**
> revokeBoxAccessGrant()


### Example

```typescript
import {
    BoxAccessGrantApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxAccessGrantApi(configuration);

let boxIdOrName: string; //ID or name of the box (default to undefined)
let grantId: string; //ID of the access grant to revoke (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.revokeBoxAccessGrant(
    boxIdOrName,
    grantId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | defaults to undefined|
| **grantId** | [**string**] | ID of the access grant to revoke | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Access grant has been revoked |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

