# ToolboxApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**clickMouseDeprecated**](#clickmousedeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/mouse/click | [DEPRECATED] Click mouse|
|[**createFolderDeprecated**](#createfolderdeprecated) | **POST** /toolbox/{boxId}/toolbox/files/folder | [DEPRECATED] Create folder|
|[**createPTYSessionDeprecated**](#createptysessiondeprecated) | **POST** /toolbox/{boxId}/toolbox/process/pty | [DEPRECATED] Create PTY session|
|[**createSessionDeprecated**](#createsessiondeprecated) | **POST** /toolbox/{boxId}/toolbox/process/session | [DEPRECATED] Create session|
|[**deleteFileDeprecated**](#deletefiledeprecated) | **DELETE** /toolbox/{boxId}/toolbox/files | [DEPRECATED] Delete file|
|[**deletePTYSessionDeprecated**](#deleteptysessiondeprecated) | **DELETE** /toolbox/{boxId}/toolbox/process/pty/{sessionId} | [DEPRECATED] Delete PTY session|
|[**deleteSessionDeprecated**](#deletesessiondeprecated) | **DELETE** /toolbox/{boxId}/toolbox/process/session/{sessionId} | [DEPRECATED] Delete session|
|[**downloadFileDeprecated**](#downloadfiledeprecated) | **GET** /toolbox/{boxId}/toolbox/files/download | [DEPRECATED] Download file|
|[**downloadFilesDeprecated**](#downloadfilesdeprecated) | **POST** /toolbox/{boxId}/toolbox/files/bulk-download | [DEPRECATED] Download multiple files|
|[**dragMouseDeprecated**](#dragmousedeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/mouse/drag | [DEPRECATED] Drag mouse|
|[**executeCommandDeprecated**](#executecommanddeprecated) | **POST** /toolbox/{boxId}/toolbox/process/execute | [DEPRECATED] Execute command|
|[**executeSessionCommandDeprecated**](#executesessioncommanddeprecated) | **POST** /toolbox/{boxId}/toolbox/process/session/{sessionId}/exec | [DEPRECATED] Execute command in session|
|[**findInFilesDeprecated**](#findinfilesdeprecated) | **GET** /toolbox/{boxId}/toolbox/files/find | [DEPRECATED] Search for text/pattern in files|
|[**getComputerUseStatusDeprecated**](#getcomputerusestatusdeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/status | [DEPRECATED] Get computer use status|
|[**getDisplayInfoDeprecated**](#getdisplayinfodeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/display/info | [DEPRECATED] Get display info|
|[**getFileInfoDeprecated**](#getfileinfodeprecated) | **GET** /toolbox/{boxId}/toolbox/files/info | [DEPRECATED] Get file info|
|[**getMousePositionDeprecated**](#getmousepositiondeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/mouse/position | [DEPRECATED] Get mouse position|
|[**getPTYSessionDeprecated**](#getptysessiondeprecated) | **GET** /toolbox/{boxId}/toolbox/process/pty/{sessionId} | [DEPRECATED] Get PTY session|
|[**getProcessErrorsDeprecated**](#getprocesserrorsdeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/process/{processName}/errors | [DEPRECATED] Get process errors|
|[**getProcessLogsDeprecated**](#getprocesslogsdeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/process/{processName}/logs | [DEPRECATED] Get process logs|
|[**getProcessStatusDeprecated**](#getprocessstatusdeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/process/{processName}/status | [DEPRECATED] Get process status|
|[**getProjectDirDeprecated**](#getprojectdirdeprecated) | **GET** /toolbox/{boxId}/toolbox/project-dir | [DEPRECATED] Get box project dir|
|[**getSessionCommandDeprecated**](#getsessioncommanddeprecated) | **GET** /toolbox/{boxId}/toolbox/process/session/{sessionId}/command/{commandId} | [DEPRECATED] Get session command|
|[**getSessionCommandLogsDeprecated**](#getsessioncommandlogsdeprecated) | **GET** /toolbox/{boxId}/toolbox/process/session/{sessionId}/command/{commandId}/logs | [DEPRECATED] Get command logs|
|[**getSessionDeprecated**](#getsessiondeprecated) | **GET** /toolbox/{boxId}/toolbox/process/session/{sessionId} | [DEPRECATED] Get session|
|[**getUserHomeDirDeprecated**](#getuserhomedirdeprecated) | **GET** /toolbox/{boxId}/toolbox/user-home-dir | [DEPRECATED] Get box user home dir|
|[**getWindowsDeprecated**](#getwindowsdeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/display/windows | [DEPRECATED] Get windows|
|[**getWorkDirDeprecated**](#getworkdirdeprecated) | **GET** /toolbox/{boxId}/toolbox/work-dir | [DEPRECATED] Get box work-dir|
|[**gitAddFilesDeprecated**](#gitaddfilesdeprecated) | **POST** /toolbox/{boxId}/toolbox/git/add | [DEPRECATED] Add files|
|[**gitCheckoutBranchDeprecated**](#gitcheckoutbranchdeprecated) | **POST** /toolbox/{boxId}/toolbox/git/checkout | [DEPRECATED] Checkout branch|
|[**gitCloneRepositoryDeprecated**](#gitclonerepositorydeprecated) | **POST** /toolbox/{boxId}/toolbox/git/clone | [DEPRECATED] Clone repository|
|[**gitCommitChangesDeprecated**](#gitcommitchangesdeprecated) | **POST** /toolbox/{boxId}/toolbox/git/commit | [DEPRECATED] Commit changes|
|[**gitCreateBranchDeprecated**](#gitcreatebranchdeprecated) | **POST** /toolbox/{boxId}/toolbox/git/branches | [DEPRECATED] Create branch|
|[**gitDeleteBranchDeprecated**](#gitdeletebranchdeprecated) | **DELETE** /toolbox/{boxId}/toolbox/git/branches | [DEPRECATED] Delete branch|
|[**gitGetHistoryDeprecated**](#gitgethistorydeprecated) | **GET** /toolbox/{boxId}/toolbox/git/history | [DEPRECATED] Get commit history|
|[**gitGetStatusDeprecated**](#gitgetstatusdeprecated) | **GET** /toolbox/{boxId}/toolbox/git/status | [DEPRECATED] Get git status|
|[**gitListBranchesDeprecated**](#gitlistbranchesdeprecated) | **GET** /toolbox/{boxId}/toolbox/git/branches | [DEPRECATED] Get branch list|
|[**gitPullChangesDeprecated**](#gitpullchangesdeprecated) | **POST** /toolbox/{boxId}/toolbox/git/pull | [DEPRECATED] Pull changes|
|[**gitPushChangesDeprecated**](#gitpushchangesdeprecated) | **POST** /toolbox/{boxId}/toolbox/git/push | [DEPRECATED] Push changes|
|[**listFilesDeprecated**](#listfilesdeprecated) | **GET** /toolbox/{boxId}/toolbox/files | [DEPRECATED] List files|
|[**listPTYSessionsDeprecated**](#listptysessionsdeprecated) | **GET** /toolbox/{boxId}/toolbox/process/pty | [DEPRECATED] List PTY sessions|
|[**listSessionsDeprecated**](#listsessionsdeprecated) | **GET** /toolbox/{boxId}/toolbox/process/session | [DEPRECATED] List sessions|
|[**lspCompletionsDeprecated**](#lspcompletionsdeprecated) | **POST** /toolbox/{boxId}/toolbox/lsp/completions | [DEPRECATED] Get Lsp Completions|
|[**lspDidCloseDeprecated**](#lspdidclosedeprecated) | **POST** /toolbox/{boxId}/toolbox/lsp/did-close | [DEPRECATED] Call Lsp DidClose|
|[**lspDidOpenDeprecated**](#lspdidopendeprecated) | **POST** /toolbox/{boxId}/toolbox/lsp/did-open | [DEPRECATED] Call Lsp DidOpen|
|[**lspDocumentSymbolsDeprecated**](#lspdocumentsymbolsdeprecated) | **GET** /toolbox/{boxId}/toolbox/lsp/document-symbols | [DEPRECATED] Call Lsp DocumentSymbols|
|[**lspStartDeprecated**](#lspstartdeprecated) | **POST** /toolbox/{boxId}/toolbox/lsp/start | [DEPRECATED] Start Lsp server|
|[**lspStopDeprecated**](#lspstopdeprecated) | **POST** /toolbox/{boxId}/toolbox/lsp/stop | [DEPRECATED] Stop Lsp server|
|[**lspWorkspaceSymbolsDeprecated**](#lspworkspacesymbolsdeprecated) | **GET** /toolbox/{boxId}/toolbox/lsp/workspace-symbols | [DEPRECATED] Call Lsp WorkspaceSymbols|
|[**moveFileDeprecated**](#movefiledeprecated) | **POST** /toolbox/{boxId}/toolbox/files/move | [DEPRECATED] Move file|
|[**moveMouseDeprecated**](#movemousedeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/mouse/move | [DEPRECATED] Move mouse|
|[**pressHotkeyDeprecated**](#presshotkeydeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/keyboard/hotkey | [DEPRECATED] Press hotkey|
|[**pressKeyDeprecated**](#presskeydeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/keyboard/key | [DEPRECATED] Press key|
|[**replaceInFilesDeprecated**](#replaceinfilesdeprecated) | **POST** /toolbox/{boxId}/toolbox/files/replace | [DEPRECATED] Replace in files|
|[**resizePTYSessionDeprecated**](#resizeptysessiondeprecated) | **POST** /toolbox/{boxId}/toolbox/process/pty/{sessionId}/resize | [DEPRECATED] Resize PTY session|
|[**restartProcessDeprecated**](#restartprocessdeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/process/{processName}/restart | [DEPRECATED] Restart process|
|[**scrollMouseDeprecated**](#scrollmousedeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/mouse/scroll | [DEPRECATED] Scroll mouse|
|[**searchFilesDeprecated**](#searchfilesdeprecated) | **GET** /toolbox/{boxId}/toolbox/files/search | [DEPRECATED] Search files|
|[**setFilePermissionsDeprecated**](#setfilepermissionsdeprecated) | **POST** /toolbox/{boxId}/toolbox/files/permissions | [DEPRECATED] Set file permissions|
|[**startComputerUseDeprecated**](#startcomputerusedeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/start | [DEPRECATED] Start computer use processes|
|[**stopComputerUseDeprecated**](#stopcomputerusedeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/stop | [DEPRECATED] Stop computer use processes|
|[**takeCompressedRegionScreenshotDeprecated**](#takecompressedregionscreenshotdeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/screenshot/region/compressed | [DEPRECATED] Take compressed region screenshot|
|[**takeCompressedScreenshotDeprecated**](#takecompressedscreenshotdeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/screenshot/compressed | [DEPRECATED] Take compressed screenshot|
|[**takeRegionScreenshotDeprecated**](#takeregionscreenshotdeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/screenshot/region | [DEPRECATED] Take region screenshot|
|[**takeScreenshotDeprecated**](#takescreenshotdeprecated) | **GET** /toolbox/{boxId}/toolbox/computeruse/screenshot | [DEPRECATED] Take screenshot|
|[**typeTextDeprecated**](#typetextdeprecated) | **POST** /toolbox/{boxId}/toolbox/computeruse/keyboard/type | [DEPRECATED] Type text|
|[**uploadFileDeprecated**](#uploadfiledeprecated) | **POST** /toolbox/{boxId}/toolbox/files/upload | [DEPRECATED] Upload file|
|[**uploadFilesDeprecated**](#uploadfilesdeprecated) | **POST** /toolbox/{boxId}/toolbox/files/bulk-upload | [DEPRECATED] Upload multiple files|

# **clickMouseDeprecated**
> MouseClickResponse clickMouseDeprecated(mouseClickRequest)

Click mouse at specified coordinates

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    MouseClickRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let mouseClickRequest: MouseClickRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.clickMouseDeprecated(
    boxId,
    mouseClickRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **mouseClickRequest** | **MouseClickRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**MouseClickResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Mouse clicked successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createFolderDeprecated**
> createFolderDeprecated()

Create folder inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let mode: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createFolderDeprecated(
    boxId,
    path,
    mode,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **mode** | [**string**] |  | defaults to undefined|
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
|**200** | Folder created successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createPTYSessionDeprecated**
> PtyCreateResponse createPTYSessionDeprecated(ptyCreateRequest)

Create a new PTY session in the box

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    PtyCreateRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let ptyCreateRequest: PtyCreateRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createPTYSessionDeprecated(
    boxId,
    ptyCreateRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **ptyCreateRequest** | **PtyCreateRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**PtyCreateResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | PTY session created successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createSessionDeprecated**
> createSessionDeprecated(createSessionRequest)

Create a new session in the box

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    CreateSessionRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let createSessionRequest: CreateSessionRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createSessionDeprecated(
    boxId,
    createSessionRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createSessionRequest** | **CreateSessionRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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

# **deleteFileDeprecated**
> deleteFileDeprecated()

Delete file inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let recursive: boolean; // (optional) (default to undefined)

const { status, data } = await apiInstance.deleteFileDeprecated(
    boxId,
    path,
    xBoxLiteOrganizationID,
    recursive
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **recursive** | [**boolean**] |  | (optional) defaults to undefined|


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
|**200** | File deleted successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deletePTYSessionDeprecated**
> deletePTYSessionDeprecated()

Delete a PTY session and terminate the associated process

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let sessionId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deletePTYSessionDeprecated(
    boxId,
    sessionId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **sessionId** | [**string**] |  | defaults to undefined|
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
|**200** | PTY session deleted successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteSessionDeprecated**
> deleteSessionDeprecated()

Delete a specific session

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let sessionId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deleteSessionDeprecated(
    boxId,
    sessionId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **sessionId** | [**string**] |  | defaults to undefined|
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
|**200** | Session deleted successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **downloadFileDeprecated**
> File downloadFileDeprecated()

Download file from box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.downloadFileDeprecated(
    boxId,
    path,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**File**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | File downloaded successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **downloadFilesDeprecated**
> File downloadFilesDeprecated(downloadFiles)

Streams back a multipart/form-data bundle of the requested paths

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    DownloadFiles
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let downloadFiles: DownloadFiles; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.downloadFilesDeprecated(
    boxId,
    downloadFiles,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **downloadFiles** | **DownloadFiles**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**File**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | A multipart/form-data response with each file as a part |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **dragMouseDeprecated**
> MouseDragResponse dragMouseDeprecated(mouseDragRequest)

Drag mouse from start to end coordinates

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    MouseDragRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let mouseDragRequest: MouseDragRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.dragMouseDeprecated(
    boxId,
    mouseDragRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **mouseDragRequest** | **MouseDragRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**MouseDragResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Mouse dragged successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **executeCommandDeprecated**
> ExecuteResponse executeCommandDeprecated(executeRequest)

Execute command synchronously inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    ExecuteRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let executeRequest: ExecuteRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.executeCommandDeprecated(
    boxId,
    executeRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **executeRequest** | **ExecuteRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ExecuteResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Command executed successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **executeSessionCommandDeprecated**
> SessionExecuteResponse executeSessionCommandDeprecated(sessionExecuteRequest)

Execute a command in a specific session

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    SessionExecuteRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let sessionId: string; // (default to undefined)
let sessionExecuteRequest: SessionExecuteRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.executeSessionCommandDeprecated(
    boxId,
    sessionId,
    sessionExecuteRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **sessionExecuteRequest** | **SessionExecuteRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **sessionId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**SessionExecuteResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Command executed successfully |  -  |
|**202** | Command accepted and is being processed |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **findInFilesDeprecated**
> Array<Match> findInFilesDeprecated()

Search for text/pattern inside box files

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let pattern: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.findInFilesDeprecated(
    boxId,
    path,
    pattern,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **pattern** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<Match>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Search completed successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getComputerUseStatusDeprecated**
> ComputerUseStatusResponse getComputerUseStatusDeprecated()

Get status of all VNC desktop processes

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getComputerUseStatusDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ComputerUseStatusResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Computer use status retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getDisplayInfoDeprecated**
> DisplayInfoResponse getDisplayInfoDeprecated()

Get information about displays

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getDisplayInfoDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**DisplayInfoResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Display info retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getFileInfoDeprecated**
> FileInfo getFileInfoDeprecated()

Get file info inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getFileInfoDeprecated(
    boxId,
    path,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**FileInfo**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | File info retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getMousePositionDeprecated**
> MousePosition getMousePositionDeprecated()

Get current mouse cursor position

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getMousePositionDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**MousePosition**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Mouse position retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getPTYSessionDeprecated**
> PtySessionInfo getPTYSessionDeprecated()

Get PTY session information by ID

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let sessionId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getPTYSessionDeprecated(
    boxId,
    sessionId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **sessionId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**PtySessionInfo**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | PTY session retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getProcessErrorsDeprecated**
> ProcessErrorsResponse getProcessErrorsDeprecated()

Get error logs for a specific VNC process

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let processName: string; // (default to undefined)
let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getProcessErrorsDeprecated(
    processName,
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **processName** | [**string**] |  | defaults to undefined|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ProcessErrorsResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Process errors retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getProcessLogsDeprecated**
> ProcessLogsResponse getProcessLogsDeprecated()

Get logs for a specific VNC process

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let processName: string; // (default to undefined)
let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getProcessLogsDeprecated(
    processName,
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **processName** | [**string**] |  | defaults to undefined|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ProcessLogsResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Process logs retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getProcessStatusDeprecated**
> ProcessStatusResponse getProcessStatusDeprecated()

Get status of a specific VNC process

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let processName: string; // (default to undefined)
let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getProcessStatusDeprecated(
    processName,
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **processName** | [**string**] |  | defaults to undefined|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ProcessStatusResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Process status retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getProjectDirDeprecated**
> ProjectDirResponse getProjectDirDeprecated()


### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getProjectDirDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ProjectDirResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Project directory retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getSessionCommandDeprecated**
> Command getSessionCommandDeprecated()

Get session command by ID

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let sessionId: string; // (default to undefined)
let commandId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getSessionCommandDeprecated(
    boxId,
    sessionId,
    commandId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **sessionId** | [**string**] |  | defaults to undefined|
| **commandId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Command**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Session command retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getSessionCommandLogsDeprecated**
> string getSessionCommandLogsDeprecated()

Get logs for a specific command in a session

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let sessionId: string; // (default to undefined)
let commandId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let follow: boolean; //Whether to stream the logs (optional) (default to undefined)

const { status, data } = await apiInstance.getSessionCommandLogsDeprecated(
    boxId,
    sessionId,
    commandId,
    xBoxLiteOrganizationID,
    follow
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **sessionId** | [**string**] |  | defaults to undefined|
| **commandId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **follow** | [**boolean**] | Whether to stream the logs | (optional) defaults to undefined|


### Return type

**string**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: text/plain


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Command log stream marked with stdout and stderr prefixes |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getSessionDeprecated**
> Session getSessionDeprecated()

Get session by ID

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let sessionId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getSessionDeprecated(
    boxId,
    sessionId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **sessionId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Session**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Session retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getUserHomeDirDeprecated**
> UserHomeDirResponse getUserHomeDirDeprecated()


### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getUserHomeDirDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**UserHomeDirResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | User home directory retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getWindowsDeprecated**
> WindowsResponse getWindowsDeprecated()

Get list of open windows

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getWindowsDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**WindowsResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Windows list retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getWorkDirDeprecated**
> WorkDirResponse getWorkDirDeprecated()


### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getWorkDirDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**WorkDirResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Work-dir retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitAddFilesDeprecated**
> gitAddFilesDeprecated(gitAddRequest)

Add files to git commit

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    GitAddRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let gitAddRequest: GitAddRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitAddFilesDeprecated(
    boxId,
    gitAddRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **gitAddRequest** | **GitAddRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Files added to git successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitCheckoutBranchDeprecated**
> gitCheckoutBranchDeprecated(gitCheckoutRequest)

Checkout branch or commit in git repository

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    GitCheckoutRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let gitCheckoutRequest: GitCheckoutRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitCheckoutBranchDeprecated(
    boxId,
    gitCheckoutRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **gitCheckoutRequest** | **GitCheckoutRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Branch checked out successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitCloneRepositoryDeprecated**
> gitCloneRepositoryDeprecated(gitCloneRequest)

Clone git repository

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    GitCloneRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let gitCloneRequest: GitCloneRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitCloneRepositoryDeprecated(
    boxId,
    gitCloneRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **gitCloneRequest** | **GitCloneRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Repository cloned successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitCommitChangesDeprecated**
> GitCommitResponse gitCommitChangesDeprecated(gitCommitRequest)

Commit changes to git repository

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    GitCommitRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let gitCommitRequest: GitCommitRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitCommitChangesDeprecated(
    boxId,
    gitCommitRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **gitCommitRequest** | **GitCommitRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**GitCommitResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Changes committed successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitCreateBranchDeprecated**
> gitCreateBranchDeprecated(gitBranchRequest)

Create branch on git repository

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    GitBranchRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let gitBranchRequest: GitBranchRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitCreateBranchDeprecated(
    boxId,
    gitBranchRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **gitBranchRequest** | **GitBranchRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Branch created successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitDeleteBranchDeprecated**
> gitDeleteBranchDeprecated(gitDeleteBranchRequest)

Delete branch on git repository

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    GitDeleteBranchRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let gitDeleteBranchRequest: GitDeleteBranchRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitDeleteBranchDeprecated(
    boxId,
    gitDeleteBranchRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **gitDeleteBranchRequest** | **GitDeleteBranchRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Branch deleted successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitGetHistoryDeprecated**
> Array<GitCommitInfo> gitGetHistoryDeprecated()

Get commit history from git repository

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitGetHistoryDeprecated(
    boxId,
    path,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<GitCommitInfo>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Commit history retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitGetStatusDeprecated**
> GitStatus gitGetStatusDeprecated()

Get status from git repository

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitGetStatusDeprecated(
    boxId,
    path,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**GitStatus**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Git status retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitListBranchesDeprecated**
> ListBranchResponse gitListBranchesDeprecated()

Get branch list from git repository

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitListBranchesDeprecated(
    boxId,
    path,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ListBranchResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Branch list retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitPullChangesDeprecated**
> gitPullChangesDeprecated(gitRepoRequest)

Pull changes from remote

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    GitRepoRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let gitRepoRequest: GitRepoRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitPullChangesDeprecated(
    boxId,
    gitRepoRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **gitRepoRequest** | **GitRepoRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Changes pulled successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **gitPushChangesDeprecated**
> gitPushChangesDeprecated(gitRepoRequest)

Push changes to remote

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    GitRepoRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let gitRepoRequest: GitRepoRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.gitPushChangesDeprecated(
    boxId,
    gitRepoRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **gitRepoRequest** | **GitRepoRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Changes pushed successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listFilesDeprecated**
> Array<FileInfo> listFilesDeprecated()


### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let path: string; // (optional) (default to undefined)

const { status, data } = await apiInstance.listFilesDeprecated(
    boxId,
    xBoxLiteOrganizationID,
    path
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **path** | [**string**] |  | (optional) defaults to undefined|


### Return type

**Array<FileInfo>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Files listed successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listPTYSessionsDeprecated**
> PtyListResponse listPTYSessionsDeprecated()

List all active PTY sessions in the box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.listPTYSessionsDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**PtyListResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | PTY sessions retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listSessionsDeprecated**
> Array<Session> listSessionsDeprecated()

List all active sessions in the box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.listSessionsDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<Session>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Sessions retrieved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **lspCompletionsDeprecated**
> CompletionList lspCompletionsDeprecated(lspCompletionParams)

The Completion request is sent from the client to the server to compute completion items at a given cursor position.

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    LspCompletionParams
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let lspCompletionParams: LspCompletionParams; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.lspCompletionsDeprecated(
    boxId,
    lspCompletionParams,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **lspCompletionParams** | **LspCompletionParams**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**CompletionList**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **lspDidCloseDeprecated**
> lspDidCloseDeprecated(lspDocumentRequest)

The document close notification is sent from the client to the server when the document got closed in the client.

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    LspDocumentRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let lspDocumentRequest: LspDocumentRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.lspDidCloseDeprecated(
    boxId,
    lspDocumentRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **lspDocumentRequest** | **LspDocumentRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **lspDidOpenDeprecated**
> lspDidOpenDeprecated(lspDocumentRequest)

The document open notification is sent from the client to the server to signal newly opened text documents.

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    LspDocumentRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let lspDocumentRequest: LspDocumentRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.lspDidOpenDeprecated(
    boxId,
    lspDocumentRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **lspDocumentRequest** | **LspDocumentRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **lspDocumentSymbolsDeprecated**
> Array<LspSymbol> lspDocumentSymbolsDeprecated()

The document symbol request is sent from the client to the server.

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let languageId: string; // (default to undefined)
let pathToProject: string; // (default to undefined)
let uri: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.lspDocumentSymbolsDeprecated(
    boxId,
    languageId,
    pathToProject,
    uri,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **languageId** | [**string**] |  | defaults to undefined|
| **pathToProject** | [**string**] |  | defaults to undefined|
| **uri** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<LspSymbol>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **lspStartDeprecated**
> lspStartDeprecated(lspServerRequest)

Start Lsp server process inside box project

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    LspServerRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let lspServerRequest: LspServerRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.lspStartDeprecated(
    boxId,
    lspServerRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **lspServerRequest** | **LspServerRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **lspStopDeprecated**
> lspStopDeprecated(lspServerRequest)

Stop Lsp server process inside box project

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    LspServerRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let lspServerRequest: LspServerRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.lspStopDeprecated(
    boxId,
    lspServerRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **lspServerRequest** | **LspServerRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **lspWorkspaceSymbolsDeprecated**
> Array<LspSymbol> lspWorkspaceSymbolsDeprecated()

The workspace symbol request is sent from the client to the server to list project-wide symbols matching the query string.

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let languageId: string; // (default to undefined)
let pathToProject: string; // (default to undefined)
let query: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.lspWorkspaceSymbolsDeprecated(
    boxId,
    languageId,
    pathToProject,
    query,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **languageId** | [**string**] |  | defaults to undefined|
| **pathToProject** | [**string**] |  | defaults to undefined|
| **query** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<LspSymbol>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **moveFileDeprecated**
> moveFileDeprecated()

Move file inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let source: string; // (default to undefined)
let destination: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.moveFileDeprecated(
    boxId,
    source,
    destination,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **source** | [**string**] |  | defaults to undefined|
| **destination** | [**string**] |  | defaults to undefined|
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
|**200** | File moved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **moveMouseDeprecated**
> MouseMoveResponse moveMouseDeprecated(mouseMoveRequest)

Move mouse cursor to specified coordinates

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    MouseMoveRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let mouseMoveRequest: MouseMoveRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.moveMouseDeprecated(
    boxId,
    mouseMoveRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **mouseMoveRequest** | **MouseMoveRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**MouseMoveResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Mouse moved successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **pressHotkeyDeprecated**
> pressHotkeyDeprecated(keyboardHotkeyRequest)

Press a hotkey combination

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    KeyboardHotkeyRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let keyboardHotkeyRequest: KeyboardHotkeyRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.pressHotkeyDeprecated(
    boxId,
    keyboardHotkeyRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **keyboardHotkeyRequest** | **KeyboardHotkeyRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Hotkey pressed successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **pressKeyDeprecated**
> pressKeyDeprecated(keyboardPressRequest)

Press a key with optional modifiers

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    KeyboardPressRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let keyboardPressRequest: KeyboardPressRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.pressKeyDeprecated(
    boxId,
    keyboardPressRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **keyboardPressRequest** | **KeyboardPressRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Key pressed successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **replaceInFilesDeprecated**
> Array<ReplaceResult> replaceInFilesDeprecated(replaceRequest)

Replace text/pattern in multiple files inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    ReplaceRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let replaceRequest: ReplaceRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.replaceInFilesDeprecated(
    boxId,
    replaceRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **replaceRequest** | **ReplaceRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<ReplaceResult>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Text replaced successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **resizePTYSessionDeprecated**
> PtySessionInfo resizePTYSessionDeprecated(ptyResizeRequest)

Resize a PTY session

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    PtyResizeRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let sessionId: string; // (default to undefined)
let ptyResizeRequest: PtyResizeRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.resizePTYSessionDeprecated(
    boxId,
    sessionId,
    ptyResizeRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **ptyResizeRequest** | **PtyResizeRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **sessionId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**PtySessionInfo**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | PTY session resized successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **restartProcessDeprecated**
> ProcessRestartResponse restartProcessDeprecated()

Restart a specific VNC process

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let processName: string; // (default to undefined)
let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.restartProcessDeprecated(
    processName,
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **processName** | [**string**] |  | defaults to undefined|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ProcessRestartResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Process restarted successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **scrollMouseDeprecated**
> MouseScrollResponse scrollMouseDeprecated(mouseScrollRequest)

Scroll mouse at specified coordinates

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    MouseScrollRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let mouseScrollRequest: MouseScrollRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.scrollMouseDeprecated(
    boxId,
    mouseScrollRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **mouseScrollRequest** | **MouseScrollRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**MouseScrollResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Mouse scrolled successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **searchFilesDeprecated**
> SearchFilesResponse searchFilesDeprecated()

Search for files inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let pattern: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.searchFilesDeprecated(
    boxId,
    path,
    pattern,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **pattern** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**SearchFilesResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Search completed successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **setFilePermissionsDeprecated**
> setFilePermissionsDeprecated()

Set file owner/group/permissions inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let owner: string; // (optional) (default to undefined)
let group: string; // (optional) (default to undefined)
let mode: string; // (optional) (default to undefined)

const { status, data } = await apiInstance.setFilePermissionsDeprecated(
    boxId,
    path,
    xBoxLiteOrganizationID,
    owner,
    group,
    mode
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **owner** | [**string**] |  | (optional) defaults to undefined|
| **group** | [**string**] |  | (optional) defaults to undefined|
| **mode** | [**string**] |  | (optional) defaults to undefined|


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
|**200** | File permissions updated successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **startComputerUseDeprecated**
> ComputerUseStartResponse startComputerUseDeprecated()

Start all VNC desktop processes (Xvfb, xfce4, x11vnc, novnc)

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.startComputerUseDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ComputerUseStartResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Computer use processes started successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **stopComputerUseDeprecated**
> ComputerUseStopResponse stopComputerUseDeprecated()

Stop all VNC desktop processes (Xvfb, xfce4, x11vnc, novnc)

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.stopComputerUseDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ComputerUseStopResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Computer use processes stopped successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **takeCompressedRegionScreenshotDeprecated**
> CompressedScreenshotResponse takeCompressedRegionScreenshotDeprecated()

Take a compressed screenshot of a specific region

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let height: number; // (default to undefined)
let width: number; // (default to undefined)
let y: number; // (default to undefined)
let x: number; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let scale: number; // (optional) (default to undefined)
let quality: number; // (optional) (default to undefined)
let format: string; // (optional) (default to undefined)
let showCursor: boolean; // (optional) (default to undefined)

const { status, data } = await apiInstance.takeCompressedRegionScreenshotDeprecated(
    boxId,
    height,
    width,
    y,
    x,
    xBoxLiteOrganizationID,
    scale,
    quality,
    format,
    showCursor
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **height** | [**number**] |  | defaults to undefined|
| **width** | [**number**] |  | defaults to undefined|
| **y** | [**number**] |  | defaults to undefined|
| **x** | [**number**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **scale** | [**number**] |  | (optional) defaults to undefined|
| **quality** | [**number**] |  | (optional) defaults to undefined|
| **format** | [**string**] |  | (optional) defaults to undefined|
| **showCursor** | [**boolean**] |  | (optional) defaults to undefined|


### Return type

**CompressedScreenshotResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Compressed region screenshot taken successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **takeCompressedScreenshotDeprecated**
> CompressedScreenshotResponse takeCompressedScreenshotDeprecated()

Take a compressed screenshot with format, quality, and scale options

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let scale: number; // (optional) (default to undefined)
let quality: number; // (optional) (default to undefined)
let format: string; // (optional) (default to undefined)
let showCursor: boolean; // (optional) (default to undefined)

const { status, data } = await apiInstance.takeCompressedScreenshotDeprecated(
    boxId,
    xBoxLiteOrganizationID,
    scale,
    quality,
    format,
    showCursor
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **scale** | [**number**] |  | (optional) defaults to undefined|
| **quality** | [**number**] |  | (optional) defaults to undefined|
| **format** | [**string**] |  | (optional) defaults to undefined|
| **showCursor** | [**boolean**] |  | (optional) defaults to undefined|


### Return type

**CompressedScreenshotResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Compressed screenshot taken successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **takeRegionScreenshotDeprecated**
> RegionScreenshotResponse takeRegionScreenshotDeprecated()

Take a screenshot of a specific region

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let height: number; // (default to undefined)
let width: number; // (default to undefined)
let y: number; // (default to undefined)
let x: number; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let showCursor: boolean; // (optional) (default to undefined)

const { status, data } = await apiInstance.takeRegionScreenshotDeprecated(
    boxId,
    height,
    width,
    y,
    x,
    xBoxLiteOrganizationID,
    showCursor
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **height** | [**number**] |  | defaults to undefined|
| **width** | [**number**] |  | defaults to undefined|
| **y** | [**number**] |  | defaults to undefined|
| **x** | [**number**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **showCursor** | [**boolean**] |  | (optional) defaults to undefined|


### Return type

**RegionScreenshotResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Region screenshot taken successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **takeScreenshotDeprecated**
> ScreenshotResponse takeScreenshotDeprecated()

Take a screenshot of the entire screen

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let showCursor: boolean; // (optional) (default to undefined)

const { status, data } = await apiInstance.takeScreenshotDeprecated(
    boxId,
    xBoxLiteOrganizationID,
    showCursor
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **showCursor** | [**boolean**] |  | (optional) defaults to undefined|


### Return type

**ScreenshotResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Screenshot taken successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **typeTextDeprecated**
> typeTextDeprecated(keyboardTypeRequest)

Type text using keyboard

### Example

```typescript
import {
    ToolboxApi,
    Configuration,
    KeyboardTypeRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let keyboardTypeRequest: KeyboardTypeRequest; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.typeTextDeprecated(
    boxId,
    keyboardTypeRequest,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **keyboardTypeRequest** | **KeyboardTypeRequest**|  | |
| **boxId** | [**string**] |  | defaults to undefined|
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
|**200** | Text typed successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **uploadFileDeprecated**
> uploadFileDeprecated()

Upload file inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let path: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let file: File; // (optional) (default to undefined)

const { status, data } = await apiInstance.uploadFileDeprecated(
    boxId,
    path,
    xBoxLiteOrganizationID,
    file
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **path** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **file** | [**File**] |  | (optional) defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: multipart/form-data
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | File uploaded successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **uploadFilesDeprecated**
> uploadFilesDeprecated()

Upload multiple files inside box

### Example

```typescript
import {
    ToolboxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ToolboxApi(configuration);

let boxId: string; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.uploadFilesDeprecated(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: multipart/form-data
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Files uploaded successfully |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

