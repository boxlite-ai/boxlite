# BoxInfoResponse


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**daemonVersion** | **string** |  | [optional] [default to undefined]
**exitCode** | **number** | ExitCode is how the box\&#39;s main command ended, present once the runtime recorded it: its own code when it exited, or 128 + n when a signal ended it. Stopping a box signals that command, so a stop is recorded here too. Absence, not 0, is what says \&quot;not recorded\&quot;: 0 is the exit code of every command that succeeded, so a reader has to tell a missing field from a zero one. | [optional] [default to undefined]
**state** | [**EnumsBoxState**](EnumsBoxState.md) |  | [optional] [default to undefined]

## Example

```typescript
import { BoxInfoResponse } from './api';

const instance: BoxInfoResponse = {
    daemonVersion,
    exitCode,
    state,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
