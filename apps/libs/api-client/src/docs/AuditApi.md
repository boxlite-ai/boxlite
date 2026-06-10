# AuditApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getAllAuditLogs**](#getallauditlogs) | **GET** /audit | Get all audit logs|
|[**getOrganizationAuditLogs**](#getorganizationauditlogs) | **GET** /audit/organizations/{organizationId} | Get audit logs for organization|

# **getAllAuditLogs**
> PaginatedAuditLogs getAllAuditLogs()


### Example

```typescript
import {
    AuditApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AuditApi(configuration);

let page: number; //Page number of the results (optional) (default to 1)
let limit: number; //Number of results per page (optional) (default to 100)
let from: Date; //From date (ISO 8601 format) (optional) (default to undefined)
let to: Date; //To date (ISO 8601 format) (optional) (default to undefined)
let nextToken: string; //Token for cursor-based pagination. When provided, takes precedence over page parameter. (optional) (default to undefined)

const { status, data } = await apiInstance.getAllAuditLogs(
    page,
    limit,
    from,
    to,
    nextToken
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **page** | [**number**] | Page number of the results | (optional) defaults to 1|
| **limit** | [**number**] | Number of results per page | (optional) defaults to 100|
| **from** | [**Date**] | From date (ISO 8601 format) | (optional) defaults to undefined|
| **to** | [**Date**] | To date (ISO 8601 format) | (optional) defaults to undefined|
| **nextToken** | [**string**] | Token for cursor-based pagination. When provided, takes precedence over page parameter. | (optional) defaults to undefined|


### Return type

**PaginatedAuditLogs**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Paginated list of all audit logs |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getOrganizationAuditLogs**
> PaginatedAuditLogs getOrganizationAuditLogs()


### Example

```typescript
import {
    AuditApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AuditApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let page: number; //Page number of the results (optional) (default to 1)
let limit: number; //Number of results per page (optional) (default to 100)
let from: Date; //From date (ISO 8601 format) (optional) (default to undefined)
let to: Date; //To date (ISO 8601 format) (optional) (default to undefined)
let nextToken: string; //Token for cursor-based pagination. When provided, takes precedence over page parameter. (optional) (default to undefined)

const { status, data } = await apiInstance.getOrganizationAuditLogs(
    organizationId,
    page,
    limit,
    from,
    to,
    nextToken
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **page** | [**number**] | Page number of the results | (optional) defaults to 1|
| **limit** | [**number**] | Number of results per page | (optional) defaults to 100|
| **from** | [**Date**] | From date (ISO 8601 format) | (optional) defaults to undefined|
| **to** | [**Date**] | To date (ISO 8601 format) | (optional) defaults to undefined|
| **nextToken** | [**string**] | Token for cursor-based pagination. When provided, takes precedence over page parameter. | (optional) defaults to undefined|


### Return type

**PaginatedAuditLogs**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Paginated list of organization audit logs |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

