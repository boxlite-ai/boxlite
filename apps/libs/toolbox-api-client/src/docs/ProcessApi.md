# ProcessApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**connectPtySession**](#connectptysession) | **GET** /process/pty/{sessionId}/connect | Connect to PTY session via WebSocket|
|[**createPtySession**](#createptysession) | **POST** /process/pty | Create a new PTY session|
|[**createSession**](#createsession) | **POST** /process/session | Create a new session|
|[**deletePtySession**](#deleteptysession) | **DELETE** /process/pty/{sessionId} | Delete a PTY session|
|[**deleteSession**](#deletesession) | **DELETE** /process/session/{sessionId} | Delete a session|
|[**executeCommand**](#executecommand) | **POST** /process/execute | Execute a command|
|[**getEntrypointLogs**](#getentrypointlogs) | **GET** /process/session/entrypoint/logs | Get entrypoint logs|
|[**getEntrypointSession**](#getentrypointsession) | **GET** /process/session/entrypoint | Get entrypoint session details|
|[**getPtySession**](#getptysession) | **GET** /process/pty/{sessionId} | Get PTY session information|
|[**getSession**](#getsession) | **GET** /process/session/{sessionId} | Get session details|
|[**getSessionCommand**](#getsessioncommand) | **GET** /process/session/{sessionId}/command/{commandId} | Get session command details|
|[**getSessionCommandLogs**](#getsessioncommandlogs) | **GET** /process/session/{sessionId}/command/{commandId}/logs | Get session command logs|
|[**listPtySessions**](#listptysessions) | **GET** /process/pty | List all PTY sessions|
|[**listSessions**](#listsessions) | **GET** /process/session | List all sessions|
|[**resizePtySession**](#resizeptysession) | **POST** /process/pty/{sessionId}/resize | Resize a PTY session|
|[**sendInput**](#sendinput) | **POST** /process/session/{sessionId}/command/{commandId}/input | Send input to command|
|[**sessionExecuteCommand**](#sessionexecutecommand) | **POST** /process/session/{sessionId}/exec | Execute command in session|

# **connectPtySession**
> connectPtySession()

Establish a WebSocket connection to interact with a pseudo-terminal session

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //PTY session ID (default to undefined)

const { status, data } = await apiInstance.connectPtySession(
    sessionId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **sessionId** | [**string**] | PTY session ID | defaults to undefined|


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
|**101** | Switching Protocols - WebSocket connection established |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createPtySession**
> PtyCreateResponse createPtySession(request)

Create a new pseudo-terminal session with specified configuration

### Example

```typescript
import {
    ProcessApi,
    Configuration,
    PtyCreateRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let request: PtyCreateRequest; //PTY session creation request

const { status, data } = await apiInstance.createPtySession(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **PtyCreateRequest**| PTY session creation request | |


### Return type

**PtyCreateResponse**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Created |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createSession**
> createSession(request)

Create a new shell session for command execution

### Example

```typescript
import {
    ProcessApi,
    Configuration,
    CreateSessionRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let request: CreateSessionRequest; //Session creation request

const { status, data } = await apiInstance.createSession(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **CreateSessionRequest**| Session creation request | |


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

# **deletePtySession**
> { [key: string]: object; } deletePtySession()

Delete a pseudo-terminal session and terminate its process

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //PTY session ID (default to undefined)

const { status, data } = await apiInstance.deletePtySession(
    sessionId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **sessionId** | [**string**] | PTY session ID | defaults to undefined|


### Return type

**{ [key: string]: object; }**

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

# **deleteSession**
> deleteSession()

Delete an existing shell session

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //Session ID (default to undefined)

const { status, data } = await apiInstance.deleteSession(
    sessionId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **sessionId** | [**string**] | Session ID | defaults to undefined|


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

# **executeCommand**
> ExecuteResponse executeCommand(request)

Execute a shell command and return the output and exit code

### Example

```typescript
import {
    ProcessApi,
    Configuration,
    ExecuteRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let request: ExecuteRequest; //Command execution request

const { status, data } = await apiInstance.executeCommand(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **ExecuteRequest**| Command execution request | |


### Return type

**ExecuteResponse**

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

# **getEntrypointLogs**
> string getEntrypointLogs()

Get logs for a box entrypoint session. Supports both HTTP and WebSocket streaming.

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let follow: boolean; //Follow logs in real-time (WebSocket only) (optional) (default to undefined)

const { status, data } = await apiInstance.getEntrypointLogs(
    follow
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **follow** | [**boolean**] | Follow logs in real-time (WebSocket only) | (optional) defaults to undefined|


### Return type

**string**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: text/plain


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Entrypoint log content |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getEntrypointSession**
> Session getEntrypointSession()

Get details of an entrypoint session including its commands

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

const { status, data } = await apiInstance.getEntrypointSession();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Session**

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

# **getPtySession**
> PtySessionInfo getPtySession()

Get detailed information about a specific pseudo-terminal session

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //PTY session ID (default to undefined)

const { status, data } = await apiInstance.getPtySession(
    sessionId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **sessionId** | [**string**] | PTY session ID | defaults to undefined|


### Return type

**PtySessionInfo**

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

# **getSession**
> Session getSession()

Get details of a specific session including its commands

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //Session ID (default to undefined)

const { status, data } = await apiInstance.getSession(
    sessionId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **sessionId** | [**string**] | Session ID | defaults to undefined|


### Return type

**Session**

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

# **getSessionCommand**
> Command getSessionCommand()

Get details of a specific command within a session

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //Session ID (default to undefined)
let commandId: string; //Command ID (default to undefined)

const { status, data } = await apiInstance.getSessionCommand(
    sessionId,
    commandId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **sessionId** | [**string**] | Session ID | defaults to undefined|
| **commandId** | [**string**] | Command ID | defaults to undefined|


### Return type

**Command**

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

# **getSessionCommandLogs**
> string getSessionCommandLogs()

Get logs for a specific command within a session. Supports both HTTP and WebSocket streaming.

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //Session ID (default to undefined)
let commandId: string; //Command ID (default to undefined)
let follow: boolean; //Follow logs in real-time (WebSocket only) (optional) (default to undefined)

const { status, data } = await apiInstance.getSessionCommandLogs(
    sessionId,
    commandId,
    follow
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **sessionId** | [**string**] | Session ID | defaults to undefined|
| **commandId** | [**string**] | Command ID | defaults to undefined|
| **follow** | [**boolean**] | Follow logs in real-time (WebSocket only) | (optional) defaults to undefined|


### Return type

**string**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: text/plain


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Log content |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listPtySessions**
> PtyListResponse listPtySessions()

Get a list of all active pseudo-terminal sessions

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

const { status, data } = await apiInstance.listPtySessions();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**PtyListResponse**

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

# **listSessions**
> Array<Session> listSessions()

Get a list of all active shell sessions

### Example

```typescript
import {
    ProcessApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

const { status, data } = await apiInstance.listSessions();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Array<Session>**

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

# **resizePtySession**
> PtySessionInfo resizePtySession(request)

Resize the terminal dimensions of a pseudo-terminal session

### Example

```typescript
import {
    ProcessApi,
    Configuration,
    PtyResizeRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //PTY session ID (default to undefined)
let request: PtyResizeRequest; //Resize request with new dimensions

const { status, data } = await apiInstance.resizePtySession(
    sessionId,
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **PtyResizeRequest**| Resize request with new dimensions | |
| **sessionId** | [**string**] | PTY session ID | defaults to undefined|


### Return type

**PtySessionInfo**

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

# **sendInput**
> sendInput(request)

Send input data to a running command in a session for interactive execution

### Example

```typescript
import {
    ProcessApi,
    Configuration,
    SessionSendInputRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //Session ID (default to undefined)
let commandId: string; //Command ID (default to undefined)
let request: SessionSendInputRequest; //Input send request

const { status, data } = await apiInstance.sendInput(
    sessionId,
    commandId,
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **SessionSendInputRequest**| Input send request | |
| **sessionId** | [**string**] | Session ID | defaults to undefined|
| **commandId** | [**string**] | Command ID | defaults to undefined|


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

# **sessionExecuteCommand**
> SessionExecuteResponse sessionExecuteCommand(request)

Execute a command within an existing shell session

### Example

```typescript
import {
    ProcessApi,
    Configuration,
    SessionExecuteRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ProcessApi(configuration);

let sessionId: string; //Session ID (default to undefined)
let request: SessionExecuteRequest; //Command execution request

const { status, data } = await apiInstance.sessionExecuteCommand(
    sessionId,
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **SessionExecuteRequest**| Command execution request | |
| **sessionId** | [**string**] | Session ID | defaults to undefined|


### Return type

**SessionExecuteResponse**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**202** | Accepted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

