# OrganizationsApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**acceptOrganizationInvitation**](#acceptorganizationinvitation) | **POST** /organizations/invitations/{invitationId}/accept | Accept organization invitation|
|[**cancelOrganizationInvitation**](#cancelorganizationinvitation) | **POST** /organizations/{organizationId}/invitations/{invitationId}/cancel | Cancel organization invitation|
|[**createOrganization**](#createorganization) | **POST** /organizations | Create organization|
|[**createOrganizationInvitation**](#createorganizationinvitation) | **POST** /organizations/{organizationId}/invitations | Create organization invitation|
|[**createOrganizationRole**](#createorganizationrole) | **POST** /organizations/{organizationId}/roles | Create organization role|
|[**createRegion**](#createregion) | **POST** /regions | Create a new region|
|[**declineOrganizationInvitation**](#declineorganizationinvitation) | **POST** /organizations/invitations/{invitationId}/decline | Decline organization invitation|
|[**deleteOrganization**](#deleteorganization) | **DELETE** /organizations/{organizationId} | Delete organization|
|[**deleteOrganizationMember**](#deleteorganizationmember) | **DELETE** /organizations/{organizationId}/users/{userId} | Delete organization member|
|[**deleteOrganizationRole**](#deleteorganizationrole) | **DELETE** /organizations/{organizationId}/roles/{roleId} | Delete organization role|
|[**deleteRegion**](#deleteregion) | **DELETE** /regions/{id} | Delete a region|
|[**getOrganization**](#getorganization) | **GET** /organizations/{organizationId} | Get organization by ID|
|[**getOrganizationByBoxId**](#getorganizationbyboxid) | **GET** /organizations/by-box-id/{boxId} | Get organization by box ID|
|[**getOrganizationInvitationsCountForAuthenticatedUser**](#getorganizationinvitationscountforauthenticateduser) | **GET** /organizations/invitations/count | Get count of organization invitations for authenticated user|
|[**getOrganizationOtelConfigByBoxAuthToken**](#getorganizationotelconfigbyboxauthtoken) | **GET** /organizations/otel-config/by-box-auth-token/{authToken} | Get organization OTEL config by box auth token|
|[**getOrganizationUsageOverview**](#getorganizationusageoverview) | **GET** /organizations/{organizationId}/usage | Get organization current usage overview|
|[**getRegionById**](#getregionbyid) | **GET** /regions/{id} | Get region by ID|
|[**getRegionQuotaByBoxId**](#getregionquotabyboxid) | **GET** /organizations/region-quota/by-box-id/{boxId} | Get region quota by box ID|
|[**leaveOrganization**](#leaveorganization) | **POST** /organizations/{organizationId}/leave | Leave organization|
|[**listAvailableRegions**](#listavailableregions) | **GET** /regions | List all available regions for the organization|
|[**listOrganizationInvitations**](#listorganizationinvitations) | **GET** /organizations/{organizationId}/invitations | List pending organization invitations|
|[**listOrganizationInvitationsForAuthenticatedUser**](#listorganizationinvitationsforauthenticateduser) | **GET** /organizations/invitations | List organization invitations for authenticated user|
|[**listOrganizationMembers**](#listorganizationmembers) | **GET** /organizations/{organizationId}/users | List organization members|
|[**listOrganizationRoles**](#listorganizationroles) | **GET** /organizations/{organizationId}/roles | List organization roles|
|[**listOrganizations**](#listorganizations) | **GET** /organizations | List organizations|
|[**regenerateProxyApiKey**](#regenerateproxyapikey) | **POST** /regions/{id}/regenerate-proxy-api-key | Regenerate proxy API key for a region|
|[**regenerateSnapshotManagerCredentials**](#regeneratesnapshotmanagercredentials) | **POST** /regions/{id}/regenerate-snapshot-manager-credentials | Regenerate snapshot manager credentials for a region|
|[**regenerateSshGatewayApiKey**](#regeneratesshgatewayapikey) | **POST** /regions/{id}/regenerate-ssh-gateway-api-key | Regenerate SSH gateway API key for a region|
|[**setOrganizationDefaultRegion**](#setorganizationdefaultregion) | **PATCH** /organizations/{organizationId}/default-region | Set default region for organization|
|[**suspendOrganization**](#suspendorganization) | **POST** /organizations/{organizationId}/suspend | Suspend organization|
|[**unsuspendOrganization**](#unsuspendorganization) | **POST** /organizations/{organizationId}/unsuspend | Unsuspend organization|
|[**updateAccessForOrganizationMember**](#updateaccessfororganizationmember) | **POST** /organizations/{organizationId}/users/{userId}/access | Update access for organization member|
|[**updateBoxDefaultLimitedNetworkEgress**](#updateboxdefaultlimitednetworkegress) | **POST** /organizations/{organizationId}/box-default-limited-network-egress | Update box default limited network egress|
|[**updateExperimentalConfig**](#updateexperimentalconfig) | **PUT** /organizations/{organizationId}/experimental-config | Update experimental configuration|
|[**updateOrganizationInvitation**](#updateorganizationinvitation) | **PUT** /organizations/{organizationId}/invitations/{invitationId} | Update organization invitation|
|[**updateOrganizationQuota**](#updateorganizationquota) | **PATCH** /organizations/{organizationId}/quota | Update organization quota|
|[**updateOrganizationRegionQuota**](#updateorganizationregionquota) | **PATCH** /organizations/{organizationId}/quota/{regionId} | Update organization region quota|
|[**updateOrganizationRole**](#updateorganizationrole) | **PUT** /organizations/{organizationId}/roles/{roleId} | Update organization role|
|[**updateRegion**](#updateregion) | **PATCH** /regions/{id} | Update region configuration|

# **acceptOrganizationInvitation**
> OrganizationInvitation acceptOrganizationInvitation()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let invitationId: string; //Invitation ID (default to undefined)

const { status, data } = await apiInstance.acceptOrganizationInvitation(
    invitationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **invitationId** | [**string**] | Invitation ID | defaults to undefined|


### Return type

**OrganizationInvitation**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Organization invitation accepted successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **cancelOrganizationInvitation**
> cancelOrganizationInvitation()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let invitationId: string; //Invitation ID (default to undefined)

const { status, data } = await apiInstance.cancelOrganizationInvitation(
    organizationId,
    invitationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **invitationId** | [**string**] | Invitation ID | defaults to undefined|


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
|**204** | Organization invitation cancelled successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createOrganization**
> Organization createOrganization(createOrganization)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    CreateOrganization
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let createOrganization: CreateOrganization; //

const { status, data } = await apiInstance.createOrganization(
    createOrganization
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createOrganization** | **CreateOrganization**|  | |


### Return type

**Organization**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Organization created successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createOrganizationInvitation**
> OrganizationInvitation createOrganizationInvitation(createOrganizationInvitation)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    CreateOrganizationInvitation
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let createOrganizationInvitation: CreateOrganizationInvitation; //

const { status, data } = await apiInstance.createOrganizationInvitation(
    organizationId,
    createOrganizationInvitation
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createOrganizationInvitation** | **CreateOrganizationInvitation**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

**OrganizationInvitation**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Organization invitation created successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createOrganizationRole**
> OrganizationRole createOrganizationRole(createOrganizationRole)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    CreateOrganizationRole
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let createOrganizationRole: CreateOrganizationRole; //

const { status, data } = await apiInstance.createOrganizationRole(
    organizationId,
    createOrganizationRole
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createOrganizationRole** | **CreateOrganizationRole**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

**OrganizationRole**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Organization role created successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createRegion**
> CreateRegionResponse createRegion(createRegion)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    CreateRegion
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let createRegion: CreateRegion; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createRegion(
    createRegion,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createRegion** | **CreateRegion**|  | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**CreateRegionResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | The region has been successfully created. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **declineOrganizationInvitation**
> declineOrganizationInvitation()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let invitationId: string; //Invitation ID (default to undefined)

const { status, data } = await apiInstance.declineOrganizationInvitation(
    invitationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **invitationId** | [**string**] | Invitation ID | defaults to undefined|


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
|**200** | Organization invitation declined successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteOrganization**
> deleteOrganization()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)

const { status, data } = await apiInstance.deleteOrganization(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


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
|**204** | Organization deleted successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteOrganizationMember**
> deleteOrganizationMember()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let userId: string; //User ID (default to undefined)

const { status, data } = await apiInstance.deleteOrganizationMember(
    organizationId,
    userId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **userId** | [**string**] | User ID | defaults to undefined|


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
|**204** | User removed from organization successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteOrganizationRole**
> deleteOrganizationRole()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let roleId: string; //Role ID (default to undefined)

const { status, data } = await apiInstance.deleteOrganizationRole(
    organizationId,
    roleId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **roleId** | [**string**] | Role ID | defaults to undefined|


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
|**204** | Organization role deleted successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteRegion**
> deleteRegion()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let id: string; //Region ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deleteRegion(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Region ID | defaults to undefined|
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
|**204** | The region has been successfully deleted. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getOrganization**
> Organization getOrganization()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)

const { status, data } = await apiInstance.getOrganization(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

**Organization**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Organization details |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getOrganizationByBoxId**
> Organization getOrganizationByBoxId()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let boxId: string; //Box ID (default to undefined)

const { status, data } = await apiInstance.getOrganizationByBoxId(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**Organization**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Organization |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getOrganizationInvitationsCountForAuthenticatedUser**
> number getOrganizationInvitationsCountForAuthenticatedUser()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

const { status, data } = await apiInstance.getOrganizationInvitationsCountForAuthenticatedUser();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**number**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Count of organization invitations |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getOrganizationOtelConfigByBoxAuthToken**
> OtelConfig getOrganizationOtelConfigByBoxAuthToken()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let authToken: string; //Box Auth Token (default to undefined)

const { status, data } = await apiInstance.getOrganizationOtelConfigByBoxAuthToken(
    authToken
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **authToken** | [**string**] | Box Auth Token | defaults to undefined|


### Return type

**OtelConfig**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OTEL Config |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getOrganizationUsageOverview**
> OrganizationUsageOverview getOrganizationUsageOverview()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)

const { status, data } = await apiInstance.getOrganizationUsageOverview(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

**OrganizationUsageOverview**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Current usage overview |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getRegionById**
> Region getRegionById()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let id: string; //Region ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getRegionById(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Region ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Region**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getRegionQuotaByBoxId**
> RegionQuota getRegionQuotaByBoxId()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let boxId: string; //Box ID (default to undefined)

const { status, data } = await apiInstance.getRegionQuotaByBoxId(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | Box ID | defaults to undefined|


### Return type

**RegionQuota**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Region quota |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **leaveOrganization**
> leaveOrganization()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)

const { status, data } = await apiInstance.leaveOrganization(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


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
|**204** | Organization left successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listAvailableRegions**
> Array<Region> listAvailableRegions()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.listAvailableRegions(
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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
|**200** | List of all available regions |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listOrganizationInvitations**
> Array<OrganizationInvitation> listOrganizationInvitations()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)

const { status, data } = await apiInstance.listOrganizationInvitations(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

**Array<OrganizationInvitation>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of pending organization invitations |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listOrganizationInvitationsForAuthenticatedUser**
> Array<OrganizationInvitation> listOrganizationInvitationsForAuthenticatedUser()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

const { status, data } = await apiInstance.listOrganizationInvitationsForAuthenticatedUser();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Array<OrganizationInvitation>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of organization invitations |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listOrganizationMembers**
> Array<OrganizationUser> listOrganizationMembers()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)

const { status, data } = await apiInstance.listOrganizationMembers(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

**Array<OrganizationUser>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of organization members |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listOrganizationRoles**
> Array<OrganizationRole> listOrganizationRoles()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)

const { status, data } = await apiInstance.listOrganizationRoles(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

**Array<OrganizationRole>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of organization roles |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listOrganizations**
> Array<Organization> listOrganizations()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

const { status, data } = await apiInstance.listOrganizations();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Array<Organization>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of organizations |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **regenerateProxyApiKey**
> RegenerateApiKeyResponse regenerateProxyApiKey()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let id: string; //Region ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.regenerateProxyApiKey(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Region ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**RegenerateApiKeyResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The proxy API key has been successfully regenerated. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **regenerateSnapshotManagerCredentials**
> SnapshotManagerCredentials regenerateSnapshotManagerCredentials()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let id: string; //Region ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.regenerateSnapshotManagerCredentials(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Region ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**SnapshotManagerCredentials**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The snapshot manager credentials have been successfully regenerated. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **regenerateSshGatewayApiKey**
> RegenerateApiKeyResponse regenerateSshGatewayApiKey()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let id: string; //Region ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.regenerateSshGatewayApiKey(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Region ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**RegenerateApiKeyResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The SSH gateway API key has been successfully regenerated. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **setOrganizationDefaultRegion**
> setOrganizationDefaultRegion(updateOrganizationDefaultRegion)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    UpdateOrganizationDefaultRegion
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let updateOrganizationDefaultRegion: UpdateOrganizationDefaultRegion; //

const { status, data } = await apiInstance.setOrganizationDefaultRegion(
    organizationId,
    updateOrganizationDefaultRegion
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateOrganizationDefaultRegion** | **UpdateOrganizationDefaultRegion**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** | Default region set successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **suspendOrganization**
> suspendOrganization()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    OrganizationSuspension
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let organizationSuspension: OrganizationSuspension; // (optional)

const { status, data } = await apiInstance.suspendOrganization(
    organizationId,
    organizationSuspension
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationSuspension** | **OrganizationSuspension**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** | Organization suspended successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **unsuspendOrganization**
> unsuspendOrganization()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)

const { status, data } = await apiInstance.unsuspendOrganization(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


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
|**204** | Organization unsuspended successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateAccessForOrganizationMember**
> OrganizationUser updateAccessForOrganizationMember(updateOrganizationMemberAccess)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    UpdateOrganizationMemberAccess
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let userId: string; //User ID (default to undefined)
let updateOrganizationMemberAccess: UpdateOrganizationMemberAccess; //

const { status, data } = await apiInstance.updateAccessForOrganizationMember(
    organizationId,
    userId,
    updateOrganizationMemberAccess
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateOrganizationMemberAccess** | **UpdateOrganizationMemberAccess**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **userId** | [**string**] | User ID | defaults to undefined|


### Return type

**OrganizationUser**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Access updated successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateBoxDefaultLimitedNetworkEgress**
> updateBoxDefaultLimitedNetworkEgress(organizationBoxDefaultLimitedNetworkEgress)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    OrganizationBoxDefaultLimitedNetworkEgress
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let organizationBoxDefaultLimitedNetworkEgress: OrganizationBoxDefaultLimitedNetworkEgress; //

const { status, data } = await apiInstance.updateBoxDefaultLimitedNetworkEgress(
    organizationId,
    organizationBoxDefaultLimitedNetworkEgress
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationBoxDefaultLimitedNetworkEgress** | **OrganizationBoxDefaultLimitedNetworkEgress**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** | Box default limited network egress updated successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateExperimentalConfig**
> updateExperimentalConfig()


### Example

```typescript
import {
    OrganizationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let requestBody: { [key: string]: any; }; //Experimental configuration as a JSON object. Set to null to clear the configuration. (optional)

const { status, data } = await apiInstance.updateExperimentalConfig(
    organizationId,
    requestBody
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **requestBody** | **{ [key: string]: any; }**| Experimental configuration as a JSON object. Set to null to clear the configuration. | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateOrganizationInvitation**
> OrganizationInvitation updateOrganizationInvitation(updateOrganizationInvitation)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    UpdateOrganizationInvitation
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let invitationId: string; //Invitation ID (default to undefined)
let updateOrganizationInvitation: UpdateOrganizationInvitation; //

const { status, data } = await apiInstance.updateOrganizationInvitation(
    organizationId,
    invitationId,
    updateOrganizationInvitation
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateOrganizationInvitation** | **UpdateOrganizationInvitation**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **invitationId** | [**string**] | Invitation ID | defaults to undefined|


### Return type

**OrganizationInvitation**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Organization invitation updated successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateOrganizationQuota**
> updateOrganizationQuota(updateOrganizationQuota)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    UpdateOrganizationQuota
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let updateOrganizationQuota: UpdateOrganizationQuota; //

const { status, data } = await apiInstance.updateOrganizationQuota(
    organizationId,
    updateOrganizationQuota
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateOrganizationQuota** | **UpdateOrganizationQuota**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** | Organization quota updated successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateOrganizationRegionQuota**
> updateOrganizationRegionQuota(updateOrganizationRegionQuota)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    UpdateOrganizationRegionQuota
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let regionId: string; //ID of the region where the updated quota will be applied (default to undefined)
let updateOrganizationRegionQuota: UpdateOrganizationRegionQuota; //

const { status, data } = await apiInstance.updateOrganizationRegionQuota(
    organizationId,
    regionId,
    updateOrganizationRegionQuota
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateOrganizationRegionQuota** | **UpdateOrganizationRegionQuota**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **regionId** | [**string**] | ID of the region where the updated quota will be applied | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** | Region quota updated successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateOrganizationRole**
> OrganizationRole updateOrganizationRole(updateOrganizationRole)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    UpdateOrganizationRole
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let roleId: string; //Role ID (default to undefined)
let updateOrganizationRole: UpdateOrganizationRole; //

const { status, data } = await apiInstance.updateOrganizationRole(
    organizationId,
    roleId,
    updateOrganizationRole
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateOrganizationRole** | **UpdateOrganizationRole**|  | |
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **roleId** | [**string**] | Role ID | defaults to undefined|


### Return type

**OrganizationRole**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Role updated successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateRegion**
> updateRegion(updateRegion)


### Example

```typescript
import {
    OrganizationsApi,
    Configuration,
    UpdateRegion
} from './api';

const configuration = new Configuration();
const apiInstance = new OrganizationsApi(configuration);

let id: string; //Region ID (default to undefined)
let updateRegion: UpdateRegion; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.updateRegion(
    id,
    updateRegion,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateRegion** | **UpdateRegion**|  | |
| **id** | [**string**] | Region ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

