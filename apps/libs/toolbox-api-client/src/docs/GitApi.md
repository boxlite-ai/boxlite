# GitApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**addFiles**](#addfiles) | **POST** /git/add | Add files to Git staging|
|[**checkoutBranch**](#checkoutbranch) | **POST** /git/checkout | Checkout branch or commit|
|[**cloneRepository**](#clonerepository) | **POST** /git/clone | Clone a Git repository|
|[**commitChanges**](#commitchanges) | **POST** /git/commit | Commit changes|
|[**createBranch**](#createbranch) | **POST** /git/branches | Create a new branch|
|[**deleteBranch**](#deletebranch) | **DELETE** /git/branches | Delete a branch|
|[**getCommitHistory**](#getcommithistory) | **GET** /git/history | Get commit history|
|[**getStatus**](#getstatus) | **GET** /git/status | Get Git status|
|[**listBranches**](#listbranches) | **GET** /git/branches | List branches|
|[**pullChanges**](#pullchanges) | **POST** /git/pull | Pull changes from remote|
|[**pushChanges**](#pushchanges) | **POST** /git/push | Push changes to remote|

# **addFiles**
> addFiles(request)

Add files to the Git staging area

### Example

```typescript
import {
    GitApi,
    Configuration,
    GitAddRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let request: GitAddRequest; //Add files request

const { status, data } = await apiInstance.addFiles(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **GitAddRequest**| Add files request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **checkoutBranch**
> checkoutBranch(request)

Switch to a different branch or commit in the Git repository

### Example

```typescript
import {
    GitApi,
    Configuration,
    GitCheckoutRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let request: GitCheckoutRequest; //Checkout request

const { status, data } = await apiInstance.checkoutBranch(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **GitCheckoutRequest**| Checkout request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **cloneRepository**
> cloneRepository(request)

Clone a Git repository to the specified path

### Example

```typescript
import {
    GitApi,
    Configuration,
    GitCloneRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let request: GitCloneRequest; //Clone repository request

const { status, data } = await apiInstance.cloneRepository(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **GitCloneRequest**| Clone repository request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **commitChanges**
> GitCommitResponse commitChanges(request)

Commit staged changes to the Git repository

### Example

```typescript
import {
    GitApi,
    Configuration,
    GitCommitRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let request: GitCommitRequest; //Commit request

const { status, data } = await apiInstance.commitChanges(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **GitCommitRequest**| Commit request | |


### Return type

**GitCommitResponse**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createBranch**
> createBranch(request)

Create a new branch in the Git repository

### Example

```typescript
import {
    GitApi,
    Configuration,
    GitBranchRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let request: GitBranchRequest; //Create branch request

const { status, data } = await apiInstance.createBranch(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **GitBranchRequest**| Create branch request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Created |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteBranch**
> deleteBranch(request)

Delete a branch from the Git repository

### Example

```typescript
import {
    GitApi,
    Configuration,
    GitGitDeleteBranchRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let request: GitGitDeleteBranchRequest; //Delete branch request

const { status, data } = await apiInstance.deleteBranch(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **GitGitDeleteBranchRequest**| Delete branch request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** | No Content |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getCommitHistory**
> Array<GitCommitInfo> getCommitHistory()

Get the commit history of the Git repository

### Example

```typescript
import {
    GitApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let path: string; //Repository path (default to undefined)

const { status, data } = await apiInstance.getCommitHistory(
    path
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | Repository path | defaults to undefined|


### Return type

**Array<GitCommitInfo>**

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

# **getStatus**
> GitStatus getStatus()

Get the Git status of the repository at the specified path

### Example

```typescript
import {
    GitApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let path: string; //Repository path (default to undefined)

const { status, data } = await apiInstance.getStatus(
    path
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | Repository path | defaults to undefined|


### Return type

**GitStatus**

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

# **listBranches**
> ListBranchResponse listBranches()

Get a list of all branches in the Git repository

### Example

```typescript
import {
    GitApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let path: string; //Repository path (default to undefined)

const { status, data } = await apiInstance.listBranches(
    path
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | Repository path | defaults to undefined|


### Return type

**ListBranchResponse**

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

# **pullChanges**
> pullChanges(request)

Pull changes from the remote Git repository

### Example

```typescript
import {
    GitApi,
    Configuration,
    GitRepoRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let request: GitRepoRequest; //Pull request

const { status, data } = await apiInstance.pullChanges(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **GitRepoRequest**| Pull request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **pushChanges**
> pushChanges(request)

Push local changes to the remote Git repository

### Example

```typescript
import {
    GitApi,
    Configuration,
    GitRepoRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new GitApi(configuration);

let request: GitRepoRequest; //Push request

const { status, data } = await apiInstance.pushChanges(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **GitRepoRequest**| Push request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

