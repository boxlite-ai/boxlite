# FileSystemApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createFolder**](#createfolder) | **POST** /files/folder | Create a folder|
|[**deleteFile**](#deletefile) | **DELETE** /files | Delete a file or directory|
|[**downloadFile**](#downloadfile) | **GET** /files/download | Download a file|
|[**downloadFiles**](#downloadfiles) | **POST** /files/bulk-download | Download multiple files|
|[**findInFiles**](#findinfiles) | **GET** /files/find | Find text in files|
|[**getFileInfo**](#getfileinfo) | **GET** /files/info | Get file information|
|[**listFiles**](#listfiles) | **GET** /files | List files and directories|
|[**moveFile**](#movefile) | **POST** /files/move | Move or rename file/directory|
|[**replaceInFiles**](#replaceinfiles) | **POST** /files/replace | Replace text in files|
|[**searchFiles**](#searchfiles) | **GET** /files/search | Search files by pattern|
|[**setFilePermissions**](#setfilepermissions) | **POST** /files/permissions | Set file permissions|
|[**uploadFile**](#uploadfile) | **POST** /files/upload | Upload a file|
|[**uploadFiles**](#uploadfiles) | **POST** /files/bulk-upload | Upload multiple files|

# **createFolder**
> createFolder()

Create a folder with the specified path and optional permissions

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let path: string; //Folder path to create (default to undefined)
let mode: string; //Octal permission mode (default: 0755) (default to undefined)

const { status, data } = await apiInstance.createFolder(
    path,
    mode
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | Folder path to create | defaults to undefined|
| **mode** | [**string**] | Octal permission mode (default: 0755) | defaults to undefined|


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Created |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteFile**
> deleteFile()

Delete a file or directory at the specified path

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let path: string; //File or directory path to delete (default to undefined)
let recursive: boolean; //Enable recursive deletion for directories (optional) (default to undefined)

const { status, data } = await apiInstance.deleteFile(
    path,
    recursive
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | File or directory path to delete | defaults to undefined|
| **recursive** | [**boolean**] | Enable recursive deletion for directories | (optional) defaults to undefined|


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** | No Content |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **downloadFile**
> File downloadFile()

Download a file by providing its path

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let path: string; //File path to download (default to undefined)

const { status, data } = await apiInstance.downloadFile(
    path
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | File path to download | defaults to undefined|


### Return type

**File**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/octet-stream


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **downloadFiles**
> { [key: string]: object; } downloadFiles(downloadFiles)

Download multiple files by providing their paths

### Example

```typescript
import {
    FileSystemApi,
    Configuration,
    FilesDownloadRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let downloadFiles: FilesDownloadRequest; //Paths of files to download

const { status, data } = await apiInstance.downloadFiles(
    downloadFiles
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **downloadFiles** | **FilesDownloadRequest**| Paths of files to download | |


### Return type

**{ [key: string]: object; }**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: multipart/form-data


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **findInFiles**
> Array<Match> findInFiles()

Search for text pattern within files in a directory

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let path: string; //Directory path to search in (default to undefined)
let pattern: string; //Text pattern to search for (default to undefined)

const { status, data } = await apiInstance.findInFiles(
    path,
    pattern
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | Directory path to search in | defaults to undefined|
| **pattern** | [**string**] | Text pattern to search for | defaults to undefined|


### Return type

**Array<Match>**

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

# **getFileInfo**
> FileInfo getFileInfo()

Get detailed information about a file or directory

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let path: string; //File or directory path (default to undefined)

const { status, data } = await apiInstance.getFileInfo(
    path
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | File or directory path | defaults to undefined|


### Return type

**FileInfo**

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

# **listFiles**
> Array<FileInfo> listFiles()

List files and directories in the specified path

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let path: string; //Directory path to list (defaults to working directory) (optional) (default to undefined)

const { status, data } = await apiInstance.listFiles(
    path
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | Directory path to list (defaults to working directory) | (optional) defaults to undefined|


### Return type

**Array<FileInfo>**

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

# **moveFile**
> moveFile()

Move or rename a file or directory from source to destination

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let source: string; //Source file or directory path (default to undefined)
let destination: string; //Destination file or directory path (default to undefined)

const { status, data } = await apiInstance.moveFile(
    source,
    destination
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **source** | [**string**] | Source file or directory path | defaults to undefined|
| **destination** | [**string**] | Destination file or directory path | defaults to undefined|


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **replaceInFiles**
> Array<ReplaceResult> replaceInFiles(request)

Replace text pattern with new value in multiple files

### Example

```typescript
import {
    FileSystemApi,
    Configuration,
    ReplaceRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let request: ReplaceRequest; //Replace request

const { status, data } = await apiInstance.replaceInFiles(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **ReplaceRequest**| Replace request | |


### Return type

**Array<ReplaceResult>**

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

# **searchFiles**
> SearchFilesResponse searchFiles()

Search for files matching a specific pattern in a directory

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let path: string; //Directory path to search in (default to undefined)
let pattern: string; //File pattern to match (e.g., *.txt, *.go) (default to undefined)

const { status, data } = await apiInstance.searchFiles(
    path,
    pattern
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | Directory path to search in | defaults to undefined|
| **pattern** | [**string**] | File pattern to match (e.g., *.txt, *.go) | defaults to undefined|


### Return type

**SearchFilesResponse**

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

# **setFilePermissions**
> setFilePermissions()

Set file permissions, ownership, and group for a file or directory

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let path: string; //File or directory path (default to undefined)
let owner: string; //Owner (username or UID) (optional) (default to undefined)
let group: string; //Group (group name or GID) (optional) (default to undefined)
let mode: string; //File mode in octal format (e.g., 0755) (optional) (default to undefined)

const { status, data } = await apiInstance.setFilePermissions(
    path,
    owner,
    group,
    mode
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | File or directory path | defaults to undefined|
| **owner** | [**string**] | Owner (username or UID) | (optional) defaults to undefined|
| **group** | [**string**] | Group (group name or GID) | (optional) defaults to undefined|
| **mode** | [**string**] | File mode in octal format (e.g., 0755) | (optional) defaults to undefined|


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **uploadFile**
> { [key: string]: object; } uploadFile()

Upload a file to the specified path

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

let path: string; //Destination path for the uploaded file (default to undefined)
let file: File; //File to upload (default to undefined)

const { status, data } = await apiInstance.uploadFile(
    path,
    file
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **path** | [**string**] | Destination path for the uploaded file | defaults to undefined|
| **file** | [**File**] | File to upload | defaults to undefined|


### Return type

**{ [key: string]: object; }**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: multipart/form-data
 - **Accept**: */*


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **uploadFiles**
> uploadFiles()

Upload multiple files with their destination paths

### Example

```typescript
import {
    FileSystemApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new FileSystemApi(configuration);

const { status, data } = await apiInstance.uploadFiles();
```

### Parameters
This endpoint does not have any parameters.


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

